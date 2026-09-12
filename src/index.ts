/**
 * Cloudflare Worker for static blog comments
 * Receives comment submissions, checks Akismet for spam, and creates GitHub PRs
 */

export interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // format: "owner/repo"
  ALLOWED_ORIGIN: string; // your blog domain
  AKISMET_API_KEY: string; // your Akismet API key
  BLOG_URL: string; // your blog URL for Akismet
  // Optional Telegram notifications. Both unset means notification is skipped.
  TELEGRAM_BOT_TOKEN?: string; // from @BotFather
  TELEGRAM_CHAT_ID?: string; // the chat to notify (yours, from getUpdates)
}

interface CommentSubmission {
  postSlug: string;
  name: string;
  email?: string;
  website?: string;
  content: string;
  // Honeypot field - should be empty
  surname?: string;
}

interface AkismetCheckParams {
  blog: string;
  user_ip: string;
  user_agent: string;
  referrer?: string;
  comment_type: string;
  comment_author: string;
  comment_author_email?: string;
  comment_author_url?: string;
  comment_content: string;
}

interface GitHubCreateBlobResponse {
  sha: string;
}

interface GitHubGetRefResponse {
  object: { sha: string };
}

interface GitHubCreateTreeResponse {
  sha: string;
}

interface GitHubCreateCommitResponse {
  sha: string;
}

interface GitHubCreatePRResponse {
  number: number;
  html_url: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Only accept POST
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const submission: CommentSubmission = await request.json();

      // Validate submission
      const validation = validateSubmission(submission);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Honeypot check - if surname field is filled, it's a bot
      if (submission.surname && submission.surname.trim() !== "") {
        // Pretend success to the bot
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check Akismet for spam
      const isSpam = await checkAkismet(env, request, submission);
      if (isSpam) {
        // Pretend success to spammers (don't let them know they were caught)
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Create the comment file and PR (email is NOT included in stored data)
      const result = await createCommentPR(env, submission);

      // Notify after the response goes out. A notification failure must never
      // fail the submission, or the caller would retry and open a duplicate PR.
      ctx.waitUntil(
        sendNotification(env, submission, result.prUrl).catch((error) => {
          console.error("Failed to send comment notification:", error);
        })
      );

      return new Response(JSON.stringify({ success: true, pr: result.prUrl }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error processing comment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to process comment" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  },
};

function validateSubmission(
  submission: CommentSubmission
): { valid: true } | { valid: false; error: string } {
  if (!submission.postSlug || submission.postSlug.trim() === "") {
    return { valid: false, error: "Missing post slug" };
  }

  if (!submission.name || submission.name.trim() === "") {
    return { valid: false, error: "Name is required" };
  }

  if (submission.name.length > 100) {
    return { valid: false, error: "Name is too long" };
  }

  if (!submission.content || submission.content.trim() === "") {
    return { valid: false, error: "Comment content is required" };
  }

  if (submission.content.length > 10000) {
    return { valid: false, error: "Comment is too long" };
  }

  // Basic slug validation (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(submission.postSlug)) {
    return { valid: false, error: "Invalid post slug" };
  }

  // Validate email format if provided
  if (submission.email && submission.email.trim() !== "") {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(submission.email)) {
      return { valid: false, error: "Invalid email format" };
    }
  }

  // Validate website URL if provided
  if (submission.website && submission.website.trim() !== "") {
    try {
      new URL(submission.website);
    } catch {
      return { valid: false, error: "Invalid website URL" };
    }
  }

  return { valid: true };
}

async function checkAkismet(
  env: Env,
  request: Request,
  submission: CommentSubmission
): Promise<boolean> {
  // Build Akismet request parameters
  const params: AkismetCheckParams = {
    blog: env.BLOG_URL,
    user_ip: request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown",
    user_agent: request.headers.get("User-Agent") || "unknown",
    referrer: request.headers.get("Referer") || undefined,
    comment_type: "comment",
    comment_author: submission.name,
    comment_author_email: submission.email || undefined,
    comment_author_url: submission.website || undefined,
    comment_content: submission.content,
  };

  // Build URL-encoded body
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      body.append(key, value);
    }
  }

  try {
    const response = await fetch(
      `https://${env.AKISMET_API_KEY}.rest.akismet.com/1.1/comment-check`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }
    );

    const result = await response.text();
    
    // Akismet returns "true" if it's spam, "false" if it's not
    return result === "true";
  } catch (error) {
    // If Akismet fails, let the comment through (fail open)
    // You could change this to fail closed if you prefer
    console.error("Akismet check failed:", error);
    return false;
  }
}

async function createCommentPR(
  env: Env,
  submission: CommentSubmission
): Promise<{ prUrl: string }> {
  const timestamp = new Date().toISOString();
  const commentId = generateCommentId();
  const branchName = `comment-${submission.postSlug}-${commentId}`;

  // Create the comment data
  const commentData = {
    id: commentId,
    postSlug: submission.postSlug,
    name: submission.name.trim(),
    email: submission.email?.trim() || null,
    website: submission.website?.trim() || null,
    content: submission.content.trim(),
    date: timestamp,
  };

  const filePath = `src/data/comments/${submission.postSlug}/${commentId}.json`;
  const fileContent = JSON.stringify(commentData, null, 2);

  const [owner, repo] = env.GITHUB_REPO.split("/");
  const headers = {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "blog-comments-worker",
    "Content-Type": "application/json",
  };

  // 1. Get the SHA of the main branch
  const mainRefResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`,
    { headers }
  );

  if (!mainRefResponse.ok) {
    throw new Error(`Failed to get main branch ref: ${mainRefResponse.status}`);
  }

  const mainRef: GitHubGetRefResponse = await mainRefResponse.json();
  const mainSha = mainRef.object.sha;

  // 2. Create a new branch from main
  const createBranchResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: mainSha,
      }),
    }
  );

  if (!createBranchResponse.ok) {
    throw new Error(`Failed to create branch: ${createBranchResponse.status}`);
  }

  // 3. Create a blob with the file content
  const createBlobResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: fileContent,
        encoding: "utf-8",
      }),
    }
  );

  if (!createBlobResponse.ok) {
    throw new Error(`Failed to create blob: ${createBlobResponse.status}`);
  }

  const blob: GitHubCreateBlobResponse = await createBlobResponse.json();

  // 4. Get the tree SHA of the main branch
  const getCommitResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${mainSha}`,
    { headers }
  );

  if (!getCommitResponse.ok) {
    throw new Error(`Failed to get commit: ${getCommitResponse.status}`);
  }

  const commit: { tree: { sha: string } } = await getCommitResponse.json();

  // 5. Create a new tree with our file
  const createTreeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        base_tree: commit.tree.sha,
        tree: [
          {
            path: filePath,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          },
        ],
      }),
    }
  );

  if (!createTreeResponse.ok) {
    throw new Error(`Failed to create tree: ${createTreeResponse.status}`);
  }

  const newTree: GitHubCreateTreeResponse = await createTreeResponse.json();

  // 6. Create a commit
  const createCommitResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: `New comment on "${submission.postSlug}" from ${submission.name}`,
        tree: newTree.sha,
        parents: [mainSha],
      }),
    }
  );

  if (!createCommitResponse.ok) {
    throw new Error(`Failed to create commit: ${createCommitResponse.status}`);
  }

  const newCommit: GitHubCreateCommitResponse =
    await createCommitResponse.json();

  // 7. Update the branch to point to the new commit
  const updateRefResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        sha: newCommit.sha,
      }),
    }
  );

  if (!updateRefResponse.ok) {
    throw new Error(`Failed to update ref: ${updateRefResponse.status}`);
  }

  // 8. Create a pull request
  const createPRResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `💬 Comment on "${submission.postSlug}" from ${submission.name}`,
        body: `**New comment submitted**\n\n**Author:** ${submission.name}\n**Post:** ${submission.postSlug}\n\n---\n\n${submission.content}`,
        head: branchName,
        base: "main",
      }),
    }
  );

  if (!createPRResponse.ok) {
    throw new Error(`Failed to create PR: ${createPRResponse.status}`);
  }

  const pr: GitHubCreatePRResponse = await createPRResponse.json();

  return { prUrl: pr.html_url };
}

/**
 * Tell the blog owner on Telegram that a comment PR is waiting.
 *
 * The PR is opened by the owner's own token, and GitHub does not notify you
 * about your own actions, so watching the repo does not cover this. Sending
 * from here is also the only place that has the comment body, the commenter's
 * email (which is deliberately never committed), and the PR URL together.
 */
async function sendNotification(
  env: Env,
  submission: CommentSubmission,
  prUrl: string
): Promise<void> {
  // Notifications are opt-in: nothing configured, nothing to do.
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return;
  }

  const text = buildTelegramMessage(submission, prUrl);

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        // The PR link is the call to action, not a card to scroll past.
        link_preview_options: { is_disabled: true },
      }),
    }
  );

  // Telegram reports failures both in the status and in an `ok` field.
  const result = (await response.json()) as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram returned ${response.status}: ${result.description ?? "unknown error"}`
    );
  }
}

// Telegram rejects messages longer than 4096 characters outright, and comments
// are allowed up to 10000, so the body has to be trimmed to fit.
const TELEGRAM_MAX_MESSAGE = 4096;
const TRUNCATION_NOTE = "\n\n[trimmed \u2014 read the full comment in the PR]";

function buildTelegramMessage(
  submission: CommentSubmission,
  prUrl: string
): string {
  // Collapse whitespace so a multi-line name can't sprawl over the message.
  const name = submission.name.trim().replace(/\s+/g, " ");

  const header =
    `\u{1F4AC} <b>New comment on "${escapeHtml(submission.postSlug)}"</b>\n\n` +
    `<b>From:</b> ${escapeHtml(name)}\n` +
    `<b>Email:</b> ${escapeHtml(submission.email?.trim() || "(not provided)")}\n` +
    `<b>Website:</b> ${escapeHtml(
      submission.website?.trim() || "(not provided)"
    )}\n\n`;

  const footer = `\n\n<a href="${escapeHtml(
    prUrl
  )}">Review the pull request</a>`;

  // Only <b> and <a> are used above; both are core Telegram HTML, so the
  // parse can't fail on an unsupported tag.
  const budget = Math.max(
    0,
    TELEGRAM_MAX_MESSAGE - header.length - footer.length
  );

  let body = escapeHtml(submission.content.trim());
  if (body.length > budget) {
    body =
      truncateEscaped(body, Math.max(0, budget - TRUNCATION_NOTE.length)) +
      TRUNCATION_NOTE;
  }

  return header + body + footer;
}

/**
 * Cut escaped HTML to length without leaving a half-written entity (a stray
 * "&am") at the end, which would break Telegram's parser.
 */
function truncateEscaped(escaped: string, max: number): string {
  if (escaped.length <= max) {
    return escaped;
  }

  const cut = escaped.slice(0, max);
  const lastAmp = cut.lastIndexOf("&");
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(";")) {
    return cut.slice(0, lastAmp);
  }
  return cut;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateCommentId(): string {
  // Generate a short unique ID using timestamp + random chars
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}
