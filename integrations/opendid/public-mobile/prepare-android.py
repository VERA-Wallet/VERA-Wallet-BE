"""Apply public HTTPS transport to the existing VeraWallet patched DID CA 2.0 tree.
Usage: python3 prepare-android.py /path/to/source/did-ca-aos
Then run ./gradlew assembleDebug using the existing test signing key.
"""
from pathlib import Path
import hashlib
import re
import sys
import zipfile

app = Path(sys.argv[1]).resolve() / 'app'
source = Path(__file__).resolve().parent / 'HttpUrlConnectionTask.java'
jar = app / 'libs/did-wallet-sdk-aos-2.0.0.jar'
backup = jar.with_suffix('.jar.original')
expected = '457052364a3d223c1b214b9ebec2e762e4e298dc1d3cdeb5296e923a8666c043'
if not backup.exists():
    if hashlib.sha256(jar.read_bytes()).hexdigest() != expected:
        raise SystemExit('Expected original pinned 2.0.0 SDK JAR; restore it before applying.')
    backup.write_bytes(jar.read_bytes())
if hashlib.sha256(backup.read_bytes()).hexdigest() != expected:
    raise SystemExit('Original SDK checksum mismatch')
with zipfile.ZipFile(backup) as src, zipfile.ZipFile(jar, 'w', zipfile.ZIP_DEFLATED) as dest:
    for entry in src.infolist():
        if entry.filename != 'org/omnione/did/sdk/communication/urlconnection/HttpUrlConnectionTask.class':
            dest.writestr(entry, src.read(entry.filename))
target = app / 'src/main/java/org/omnione/did/sdk/communication/urlconnection/HttpUrlConnectionTask.java'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(source.read_bytes())
config = app / 'src/main/java/org/omnione/did/ca/config/Config.java'
config.write_text(re.sub(r'http://100\.109\.255\.108:809[0-9]', 'https://verawallet.pelicanlab.dev/opendid', config.read_text()))
gradle = app / 'build.gradle'
s = re.sub(r'versionCode \d+', 'versionCode 4', gradle.read_text())
s = re.sub(r'versionName "[^"]+"', 'versionName "1.0-verawallet-public4"', s)
gradle.write_text(s)
config = app / 'src/main/res/xml/network_security_config.xml'
config.write_text(config.read_text().replace('cleartextTrafficPermitted="true"', 'cleartextTrafficPermitted="false"'))
