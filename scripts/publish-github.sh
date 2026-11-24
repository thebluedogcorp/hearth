#!/usr/bin/env bash
# Publishes Hearth to GitHub in one command.
#
# Usage:
#   GH_TOKEN=github_pat_xxxx bash scripts/publish-github.sh            # private repo (default)
#   GH_TOKEN=github_pat_xxxx bash scripts/publish-github.sh --public   # public repo
#
# Requires a token with "repo" scope (fine-grained: Contents read/write + Administration read/write).
# Everything else — repo creation, push, tag, release with notes — happens automatically.
set -euo pipefail

REPO_NAME="${REPO_NAME:-hearth}"
VISIBILITY="private"
[[ "${1:-}" == "--public" ]] && VISIBILITY="public"

API="https://api.github.com"
AUTH=(-H "Authorization: Bearer ${GH_TOKEN:?Set GH_TOKEN to a GitHub token with repo scope}" -H "Accept: application/vnd.github+json")

# ── who am I ────────────────────────────────────────────────────────────────
LOGIN=$(curl -fsSL "${AUTH[@]}" "$API/user" | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')
echo "==> Authenticated as $LOGIN"

# ── de-template the README/CI badges ────────────────────────────────────────
sed -i "s/YOUR_GITHUB_USERNAME/$LOGIN/g" README.md .github/workflows/ci.yml docs/INSTALL.md 2>/dev/null || true

# ── create the repository ───────────────────────────────────────────────────
CREATE_CODE=$(curl -fsS -o /tmp/gh-create.json -w "%{http_code}" "${AUTH[@]}" "$API/user/repos" \
  -d "{\"name\":\"$REPO_NAME\",\"description\":\"Your private streaming platform — self-hosted media server with a desktop control panel and OTT-style web app\",\"$VISIBILITY\":true,\"has_wiki\":false,\"has_issues\":true}")
if [[ "$CREATE_CODE" == "201" ]]; then
  echo "==> Created repository $LOGIN/$REPO_NAME ($VISIBILITY)"
elif [[ "$CREATE_CODE" == "422" ]]; then
  echo "==> Repository $LOGIN/$REPO_NAME already exists — pushing to it"
else
  cat /tmp/gh-create.json; echo; echo "Could not create the repository (HTTP $CREATE_CODE)"; exit 1
fi

# ── commit & push ───────────────────────────────────────────────────────────
git init -q 2>/dev/null || true
git add -A
if ! git diff --cached --quiet; then
  git -c user.name="Hearth Release Bot" -c user.email="release@hearth.local" \
    commit -q -m "Hearth 1.0.2 — browser first-run setup, publish-ready repository, CI and release pipeline"
fi
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${LOGIN}/${REPO_NAME}.git"
git push -q -u origin main
echo "==> Pushed main"

# ── tag & push ──────────────────────────────────────────────────────────────
VERSION=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')
TAG="v$VERSION"
git tag -f "$TAG" -m "Hearth $VERSION"
git push -q -f origin "$TAG"
echo "==> Tagged $TAG"

# ── GitHub release ──────────────────────────────────────────────────────────
python3 - <<PY > /tmp/gh-release-body.json
import json
notes = open("RELEASE_NOTES.md", encoding="utf-8").read()
print(json.dumps({"tag_name": "$TAG", "name": "Hearth $VERSION — setup made a piece of cake", "body": notes, "draft": False, "prerelease": False}))
PY
RELEASE_CODE=$(curl -fsS -o /tmp/gh-release.json -w "%{http_code}" "${AUTH[@]}" "$API/repos/$LOGIN/$REPO_NAME/releases" -d @/tmp/gh-release-body.json)
if [[ "$RELEASE_CODE" == "201" ]]; then
  RELEASE_URL=$(python3 -c 'import json; print(json.load(open("/tmp/gh-release.json"))["html_url"])')
  echo "==> Release created: $RELEASE_URL"
else
  echo "==> Release not created (HTTP $RELEASE_CODE) — the tag is pushed; create the release from the web UI."
fi

# ── attach a locally built installer if present ─────────────────────────────
ASSET="dist/Hearth-Setup-$VERSION-x64.exe"
SUMS="dist/SHA256SUMS.txt"
if [[ -f "$ASSET" && -f /tmp/gh-release.json ]]; then
  UPLOAD_URL=$(python3 -c 'import json; print(json.load(open("/tmp/gh-release.json"))["upload_url"].split("{")[0])')
  sha256sum "$ASSET" > "$SUMS"
  curl -fsS -o /tmp/gh-upload.json "${AUTH[@]}" -H "Content-Type: application/octet-stream" \
    --data-binary @"$ASSET" "$UPLOAD_URL?name=$(basename "$ASSET")"
  curl -fsS -o /tmp/gh-upload2.json "${AUTH[@]}" -H "Content-Type: text/plain" \
    --data-binary @"$SUMS" "$UPLOAD_URL?name=$(basename "$SUMS")"
  echo "==> Uploaded installer + SHA256 checksums"
fi

echo
echo "Done: https://github.com/$LOGIN/$REPO_NAME"
