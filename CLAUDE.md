# Working on this repo

- Reply to the owner in Russian; code, comments and commit messages in English.
- Start each reply with one or two sentences on what you are about to do and why.
- Before merging a PR, wait for the CodeRabbit review (a few minutes), verify each finding against the
  code, fix the valid ones and say why the others are skipped.
- Hard rules for sources: public pages and official APIs only, no login, no bypassing bot protection
  (no proxies, CAPTCHA solving, fingerprint spoofing or stealth plugins); respect robots.txt, rate-limit,
  and mark a source "blocked" on 403/429/captcha instead of working around it.
- Checks before pushing: `npx tsc -p .` and `npx playwright test`.
