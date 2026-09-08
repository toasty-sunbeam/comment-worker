# Static Blog Comments for Astro

A self-hosted comment system that creates GitHub PRs for moderation. No database, no third-party services storing your data.

## How It Works

```
[User submits comment]
         ↓
[Cloudflare Worker receives POST]
         ↓
[Worker creates GitHub PR with comment as JSON file]
         ↓
[You review & merge PR]
         ↓
[GitHub Pages rebuilds site]
         ↓
[Comment appears on your blog]
```

## Setup

### 1. Create a GitHub Personal Access Token

1. Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Click "Generate new token"
3. Name it something like "blog-comments"
4. Set repository access to "Only select repositories" and choose your blog repo
5. Under "Repository permissions", set:
   - **Contents**: Read and write
   - **Pull requests**: Read and write
6. Generate and copy the token

### 2. Deploy the Cloudflare Worker

```bash
cd worker

# Install dependencies
npm install

# Login to Cloudflare (first time only)
npx wrangler login

# Set your secrets
npx wrangler secret put GITHUB_TOKEN
# Paste your GitHub token when prompted

npx wrangler secret put GITHUB_REPO
# Enter in format: yourusername/your-blog-repo

npx wrangler secret put AKISMET_API_KEY
# Get your API key from https://akismet.com/ (free for personal use)

# Update wrangler.toml with your blog domain
# Change ALLOWED_ORIGIN and BLOG_URL to your actual domain

# Deploy to production
npm run deploy:production
```

After deployment, Wrangler will show you your worker URL, something like:
`https://blog-comments.your-subdomain.workers.dev`

### 3. Add the Astro Components

Copy these files to your Astro project:

```
src/
├── components/
│   ├── CommentForm.astro
│   └── CommentList.astro
└── data/
    └── comments/
        └── .gitkeep.json   # Placeholder so the directory exists in git
```

### 4. Configure the Worker URL

Create or update your `.env` file:

```env
PUBLIC_COMMENTS_WORKER_URL=https://blog-comments.your-subdomain.workers.dev
```

Or hardcode it in `CommentForm.astro` if you prefer.

### 5. Update Your Blog Post Layout

```astro
---
import CommentList from '../components/CommentList.astro';
import CommentForm from '../components/CommentForm.astro';

const { slug } = Astro.params;
---

<article>
  <slot />
  
  <CommentList postSlug={slug} />
  <CommentForm postSlug={slug} />
</article>
```

## Testing Locally

1. Start your Astro dev server: `npm run dev`
2. In another terminal, start the worker locally: `cd worker && npm run dev`
3. The worker will run at `http://localhost:8787`
4. Update `CommentForm.astro` to use `http://localhost:8787` for testing

## Comment Workflow

1. User submits a comment on your blog
2. Worker validates the submission (spam checks, required fields)
3. Worker creates a branch and commits a JSON file like:
   ```
   src/data/comments/my-post-slug/lxyz123-abc456.json
   ```
4. Worker opens a PR with the comment content visible in the description
5. Worker emails you the comment and a link to the PR (if configured — see
   [Notifications](#notifications); GitHub itself will not notify you, because
   the PR is opened by your own token)
6. Review the PR - merge to approve, close to reject
7. Merging triggers a GitHub Pages rebuild
8. Comment appears on your site

## Comment Data Structure

Each comment is stored as a JSON file:

```json
{
  "id": "lxyz123-abc456",
  "postSlug": "my-post-slug",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "website": "https://jane.dev",
  "content": "Great post! I learned a lot.",
  "date": "2024-01-15T10:30:00.000Z"
}
```

- `email` is stored for future reply notifications (keep your repo private to prevent harvesting)
- `website` is displayed as a link on the commenter's name

## Spam Protection

The system includes multiple layers of spam protection:

1. **Akismet**: Industry-standard spam detection. Email is sent to Akismet for checking but never stored in your repo.
2. **Honeypot field**: A hidden "surname" field that bots fill out. Real users never see it.
3. **Validation**: Required fields, length limits, format checks.
4. **CORS**: Only your domain can submit comments.
5. **Manual moderation**: Every comment requires PR approval.

### Getting an Akismet API Key

1. Go to https://akismet.com/
2. Sign up for a personal account (free for personal blogs)
3. You'll receive an API key via email
4. Add it as a secret: `npx wrangler secret put AKISMET_API_KEY`

## Customization

### Styling

Both components use CSS custom properties for easy theming:

```css
:root {
  --border-color: #e0e0e0;
  --muted-color: #6c757d;
  --primary-color: #0066cc;
  --primary-hover: #0052a3;
  --focus-color: #0066cc;
  --focus-shadow: rgba(0, 102, 204, 0.15);
  --success-bg: #d4edda;
  --success-color: #155724;
  --success-border: #c3e6cb;
  --error-bg: #f8d7da;
  --error-color: #721c24;
  --error-border: #f5c6cb;
}
```

### File Path

To change where comments are stored, update:
1. `filePath` in the worker's `createCommentPR` function
2. The content collection path in your Astro config

### Notifications

The worker emails you when a comment PR is opened. This is opt-in: if
`RESEND_API_KEY`, `NOTIFY_EMAIL_TO`, and `NOTIFY_EMAIL_FROM` are not all set,
the step is skipped silently.

Do not rely on GitHub notifications instead. The PR is created with your own
personal access token, and GitHub does not notify you about your own actions,
so a repo watch will stay quiet no matter how it is configured.

```bash
npx wrangler secret put RESEND_API_KEY
# From https://resend.com/ - the free tier covers a personal blog

npx wrangler secret put NOTIFY_EMAIL_TO
# Your own address

npx wrangler secret put NOTIFY_EMAIL_FROM
# A verified sender on a domain you control, e.g. "Blog <comments@example.com>"
```

Resend requires you to verify the sending domain by adding DNS records. Any
provider with an HTTP API works the same way - swap the `fetch` call in
`sendNotification`. Cloudflare's old free MailChannels integration was
discontinued in 2024, so a provider account is required.

The email is sent with `ctx.waitUntil` after the response goes out, and
failures are logged rather than thrown: a mail outage must not fail the
submission, or the browser would retry and open a duplicate PR.

Spam never reaches this step. Honeypot hits and Akismet rejections return
early, so they cost you nothing.

The same hook could drive a Slack or Discord webhook instead.

## Costs

- **Cloudflare Workers**: Free tier includes 100,000 requests/day
- **GitHub**: Free for public repos
- **Your time**: ~5 minutes to review a PR

## Troubleshooting

### "Failed to get main branch ref"
Your repo might use `master` instead of `main`. Update the worker code to match your default branch.

### Comments not showing after merge
- Make sure GitHub Pages is set to rebuild on push
- Check that the comment file path matches what `CommentList.astro` expects (`src/data/comments/`)

### CORS errors
- Verify `ALLOWED_ORIGIN` matches your actual domain (including `https://`)
- For local testing, set it to `http://localhost:4321`

### Worker returns 500 error
Check the worker logs in the Cloudflare dashboard. Common issues:
- Invalid GitHub token
- Token doesn't have required permissions
- Repo name format wrong (should be `owner/repo`)

## License

MIT - Do whatever you want with this code.
