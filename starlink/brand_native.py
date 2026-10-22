#!/usr/bin/env python3
"""Brand a checked-out OTT-play Native Android source tree for STARLINK IPTV."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent
strings = root / "app/src/main/res/values/strings.xml"
gradle = root / "app/build.gradle.kts"
if not strings.exists() or not gradle.exists():
    raise SystemExit("Expected OTT-play Native source tree is missing")
s = strings.read_text()
assert '<string name="app_name" translatable="false">OTT-play Native</string>' in s
strings.write_text(s.replace('<string name="app_name" translatable="false">OTT-play Native</string>', '<string name="app_name" translatable="false">STARLINK IPTV</string>'))
g = gradle.read_text()
assert 'applicationId = "play.ott.foss.nativeapp"' in g
gradle.write_text(g.replace('applicationId = "play.ott.foss.nativeapp"', 'applicationId = "br.starlink.iptv"'))
values = root / "app/src/main/res/values/starlink_config.xml"
values.write_text('''<resources>
    <string name="starlink_xtream_base_url" translatable="false">https://panel.taila5c5c2.ts.net</string>
</resources>
''')
print("STARLINK IPTV name, app ID and server resource applied. Login UI integration remains to be implemented.")
