# GitHub Actions to EC2 deployment

The three applications live in separate GitHub repositories and deploy independently:

- `mountreality-backend`: Node/Express under PM2
- `mountreality-frontend`: Vite build served by Nginx
- `mountreality-owner`: Vite build served by Nginx

Pull requests targeting `main` run verification without deploying. Every merge or direct push to `main` runs verification first, then deploys to the GitHub `production` environment. A failed verification never reaches EC2. Concurrent production deployments are serialized.

## Required GitHub environment

In each repository, create an environment named `production`. Add the following environment secrets:

| Secret | Value |
| --- | --- |
| `EC2_HOST` | EC2 hostname or public IP |
| `EC2_USER` | Dedicated non-root deployment user, commonly `ubuntu` |
| `EC2_SSH_PRIVATE_KEY` | Private half of a dedicated deployment key |
| `EC2_SSH_KNOWN_HOSTS` | Verified `known_hosts` line for the EC2 host |

Do not place database, JWT, Firebase, AWS, SMTP, or payment credentials in the workflow. Backend secrets remain in the ignored `.env`/secret files on EC2.

Backend repository variables:

| Variable | Example |
| --- | --- |
| `EC2_APP_PATH` | `/var/www/mountreality-backend` |
| `PM2_APP_NAME` | `mountreality-backend` |
| `BACKEND_HEALTH_URL` | `http://127.0.0.1:8000/health/live` |

Account frontend repository variables:

| Variable | Example |
| --- | --- |
| `EC2_STATIC_ROOT` | `/var/www/mountreality-frontend` |
| `VITE_API_URL` | `https://api.example.com` |
| `PUBLIC_HEALTH_URL` | `https://app.example.com/` |

Owner frontend repository variables:

| Variable | Example |
| --- | --- |
| `EC2_STATIC_ROOT` | `/var/www/mountreality-owner` |
| `VITE_API_URL` | `https://api.example.com` |
| `PUBLIC_HEALTH_URL` | `https://owner.example.com/` |

Vite variables are public browser configuration, not secrets.

## Main-branch protection

Protect `main` in all three repositories and require pull requests plus the workflow build/verification check before merge. This makes the intended production path:

```text
commit on dev/feature branch -> pull request -> checks pass -> merge to main -> automatic EC2 deployment
```

Do not make the deployment job itself a required pre-merge check: it is intentionally skipped on pull requests and runs only after code reaches `main`.

## One-time EC2 preparation

1. Create a dedicated SSH key for GitHub Actions. Put only its public key in the deployment user's `~/.ssh/authorized_keys`; put the private key in the GitHub secret.
2. Verify the EC2 SSH host-key fingerprint through the AWS console before saving its `known_hosts` line in GitHub.
3. Ensure the deployment user can run `git`, `node`, `npm`, `pm2`, `curl`, and create files under the configured application/static paths.
4. Clone the backend repository at `EC2_APP_PATH`, check out `main`, and configure read-only GitHub access for `git fetch`. The automated script refuses to overwrite tracked EC2 changes.
5. Keep the backend `.env` and Firebase service-account file only on EC2. They are ignored by Git and survive a fast-forward pull.
6. Create the two static roots and grant the deployment user write access. Frontend workflows upload immutable release folders, atomically update a `current` symlink, roll back the symlink when health checks fail, and retain the five newest healthy releases.
7. Configure Nginx once using the examples in each repository, then add TLS certificates. Separate API, app, and owner hostnames avoid conflicts between Express root-level routes and SPA routing.
8. Run `pm2 startup` as instructed by PM2 and `pm2 save` so the backend returns after an EC2 reboot.

GitHub-hosted runner source IPs change. Do not permanently open SSH port 22 to the entire internet solely for deployment. Restrict ingress using an approved runner/network design or replace the SSH transport with AWS Systems Manager before tightening the production security group.

The backend checkout must stay on `main`. If someone edits a tracked file directly on EC2, deployment stops instead of deleting that work.

## Database migrations

Deployments deliberately run `npm ci` and restart PM2 only. They never run `start:with-migrations`, migration scripts, seeds, or database repair scripts. Review and run required migrations as a separate controlled production operation before merging code that depends on them.

## Production routing

Use three HTTPS origins:

```text
https://api.example.com    -> Nginx -> 127.0.0.1:8000 -> PM2
https://app.example.com    -> Nginx -> account frontend current release
https://owner.example.com  -> Nginx -> owner frontend current release
```

Backend production environment:

```env
NODE_ENV=production
PORT=8000
CORS_ORIGINS=https://app.example.com,https://owner.example.com
FRONTEND_URL=https://app.example.com
```

Account and owner builds both use `VITE_API_URL=https://api.example.com` from their GitHub environment variable.

## First deployment

Merge the workflow files to `main`, configure the environment secrets/variables, and run **Actions -> Deploy ... to EC2 -> Run workflow** once. After it succeeds, every later merge to `main` deploys automatically.

Backend success is gated by `GET /health/live`. Frontend success requires the built `index.html` and the configured public health URL to answer successfully.
