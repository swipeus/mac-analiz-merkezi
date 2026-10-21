#!/usr/bin/env bash
# Sürekli güncelleme döngüsü: LOOP_MINUTES boyunca her PUBLISH_EVERY saniyede bir veriyi toplar, analiz eder,
# şifreler ve gh-pages dalına yayınlar (GitHub Pages bu daldan sunar).
# main dalına yeni kod gelirse döngüden çıkar; iş akışı kendini yeni kodla yeniden başlatır.
set -u
END=$(( $(date +%s) + ${LOOP_MINUTES:-320} * 60 ))
EVERY=${PUBLISH_EVERY:-360}
REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
n=0
while [ "$(date +%s)" -lt "$END" ]; do
  start=$(date +%s)
  n=$((n + 1))
  echo "::group::Tur $n ($(date -u +%H:%M:%S) UTC)"
  if python build_static.py ../_site; then
    if [ -f ../_site/index.html ]; then
      ( cd ../_site && rm -rf .git && git init -q -b gh-pages && git add -A \
        && git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
             commit -qm "Veri güncellemesi $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        && git push -qf "$REPO_URL" gh-pages ) && echo "yayınlandı" || echo "yayın hatası"
    fi
  else
    echo "derleme hatası (bir sonraki turda tekrar denenecek)"
  fi
  echo "::endgroup::"
  # yeni kod geldiyse çık: iş akışının son adımı yeni kodla yeniden başlatır
  if git fetch -q origin main && [ "$(git rev-parse origin/main)" != "$GITHUB_SHA" ]; then
    echo "main dalında yeni kod var, döngü yeniden başlatılıyor"
    break
  fi
  took=$(( $(date +%s) - start ))
  wait=$(( EVERY - took ))
  [ "$wait" -lt 30 ] && wait=30
  [ $(( $(date +%s) + wait )) -ge "$END" ] && break
  sleep "$wait"
done
echo "döngü bitti: $n tur"
