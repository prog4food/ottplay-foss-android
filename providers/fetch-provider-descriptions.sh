#!/usr/bin/env bash
# fetch-provider-descriptions.sh: fetch helper HTML for every provider.js folder
while IFS= read -r prov; do
    dir=$(dirname "$prov")
    base=$(basename "$dir")
    url="https://ottp.eu.org/prov/${base}/about.html"
    echo "Fetching $url → $dir/about.html"
    if wget -q "$url" -O "$dir/about.html"; then
        # The upstream keeps its legacy URL namespace; use local asset paths here.
        sed -E "s@([\"'])/prov/@\\1/providers/@g" "$dir/about.html" > "$dir/about.html.tmp" &&
            mv "$dir/about.html.tmp" "$dir/about.html"
    else
        echo "Failed $url"
    fi
done < <(find . -type f -name 'provider.js' -print)
