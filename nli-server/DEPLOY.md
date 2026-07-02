# Deploying the Merit NLI backend (free)

The NLI backend is a CPU-only Docker service — it hosts a ~600MB model, so it can't run on Vercel
serverless (size/cold-start limits). Deploy it once to any free container host, then point Merit at its URL.

## Option A — Hugging Face Space (free CPU, recommended)

1. Log in (you do this once — I can't do it for you without your token):

   ```
   huggingface-cli login          # paste a token from https://huggingface.co/settings/tokens
   ```

2. Create a **Docker** Space and push this folder to it:

   ```
   huggingface-cli repo create merit-nli --type space --space_sdk docker
   cd nli-server
   git init && git remote add hf https://huggingface.co/spaces/<your-username>/merit-nli
   # HF Spaces read config from the README frontmatter — prepend it:
   printf -- '---\ntitle: Merit NLI\nsdk: docker\napp_port: 8000\npinned: false\nlicense: apache-2.0\n---\n\n' | cat - README.md > _r && mv _r README.md
   git add . && git commit -m "Merit NLI backend" && git push hf main
   ```

   The Space builds the Dockerfile (bakes HHEM-2.1-Open) and serves at
   `https://<your-username>-merit-nli.hf.space`. The score endpoint is that URL + `/score`.

## Option B — Render (free web service)

- New → Web Service → connect the GitHub repo → **Root Directory** `merit/app/nli-server`,
  Environment **Docker**. Deploy. URL + `/score` is your `MERIT_NLI_URL`.

## Option C — Fly.io

```
cd nli-server && flyctl launch --dockerfile Dockerfile   # accept CPU/1GB; flyctl deploy
```

## Then wire Merit to it

Set in Merit's env (Vercel prod + `.env.local`):

```
MERIT_NLI_URL=https://<host>/score
MERIT_NLI_MODEL=vectara/hhem-2.1-open
MERIT_STRICT_GATE=1     # optional: require BOTH the NLI leg and the judge to confirm (highest precision)
```

Verify: `curl -s <host>/healthz` → `{ "ok": true, "backend": "hhem", ... }`, then a Merit `/api/verify`
call on a contradiction returns `REFUSED` with `nli` in `methods` — the free dual-gate is live, off the LLM.
