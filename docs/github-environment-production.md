# GitHub Environment `production` (G1 apply gate)

`release.yml` will not `terraform apply` until this environment is
approved. The workflow file only *names* the environment; a repo
**admin** (Berissa) must turn on required reviewers. Yordanos does not
have admin on this repo — a Settings API call returns 403.

## Once, in the GitHub UI

1. Repo → **Settings** → **Environments** → **production**
   (create it if it is missing).
2. **Deployment branches**: limit to `main` only.
3. **Required reviewers**: add **@akezasaloi** (platform cross-reviewer)
   and **@berissamuyizere** (repo admin). Do not add the person who
   usually merges infra as the only reviewer.
4. Enable **Prevent self-review** so the author of the apply cannot
   approve their own job.
5. Leave wait timer at 0.

After that, every `main` apply:

1. `terraform plan` uploads `plan.bin` + `plan.txt` as an artifact.
2. The `terraform apply` job sits on **Review deployments**.
3. A required reviewer opens the artifact, reads the plan, then
   **Approve and deploy**.
4. Apply runs `terraform apply plan.bin` — it does **not** re-plan.

PR `pr.yml` still runs a plan for review; that plan is not what apply
uses. The Environment approves the exact saved file.
