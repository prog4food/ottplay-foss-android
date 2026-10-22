#!/usr/bin/env python3
"""Verify and unpack the exact Mode A candidate without rebuilding its browser code."""

import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024


def member_path(name):
    if name.startswith('/') or '\\' in name or ':' in name or '..' in name.split('/'):
        raise ValueError('Unsafe archive path')
    path = PurePosixPath(name)
    if any(part.endswith(('.', ' ')) for part in path.parts):
        raise ValueError('Nonportable archive path')
    return path.as_posix()


def archive_files(bundle):
    files, seen = {}, set()
    count, size = 0, 0
    for item in bundle:
        count += 1
        size += item.size
        if count > 10_000 or item.size < 0 or size > MAX_UNPACKED_BYTES:
            raise ValueError('Candidate has an invalid unpacked size')
        name = member_path(item.name)
        if not (item.isfile() or item.isdir()):
            raise ValueError('Candidate contains a link or special file')
        if name == '.' and item.isdir():
            continue
        if name.casefold() in seen:
            raise ValueError('Candidate contains duplicate paths')
        seen.add(name.casefold())
        if item.isfile():
            files[name] = item
    if count == 0:
        raise ValueError('Candidate has an invalid unpacked size')
    return files


def prepare(artifacts, destination, diagnostics, source_sha, release=False):
    artifacts, destination, diagnostics = map(Path, (artifacts, destination, diagnostics))
    if not re.fullmatch(r'[0-9a-f]{40}', source_sha):
        raise ValueError('The candidate requires the current source SHA')
    if destination.exists() or destination.is_symlink():
        raise ValueError('Candidate destination must not exist')
    archive = artifacts / 'ottplay-foss-modea.tar.gz'
    checksum = artifacts / 'ottplay-foss-modea.sha256'
    for item, limit in [(archive, MAX_ARCHIVE_BYTES), (checksum, 1024)]:
        if item.is_symlink() or not item.is_file() or item.stat().st_size > limit:
            raise ValueError('Candidate file is not a bounded regular file')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if checksum.read_text(encoding='utf-8').strip() != digest + '  ' + archive.name:
        raise ValueError('Candidate archive differs from its checksum')
    if release:
        receipt_path = artifacts / 'release-inputs-web.json'
        if receipt_path.is_symlink() or not receipt_path.is_file() or receipt_path.stat().st_size > 2_000_000:
            raise ValueError('Candidate receipt is not a bounded regular file')
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        if receipt.get('source_sha') != source_sha:
            raise ValueError('Candidate belongs to another source commit')
        entries = [item for item in receipt.get('artifacts', []) if item.get('name') == archive.name]
        if len(entries) != 1 or entries[0].get('sha256') != digest or entries[0].get('size') != archive.stat().st_size:
            raise ValueError('Candidate archive differs from its build receipt')
    with tarfile.open(archive, 'r:gz') as bundle:
        files = archive_files(bundle)
        if not {'index.html', 'dist/player.js', 'build-info.json'}.issubset(files):
            raise ValueError('Candidate is not a complete Mode A player')
        if files['build-info.json'].size > 2_000_000:
            raise ValueError('Candidate metadata exceeds size limits')
        metadata = json.load(bundle.extractfile(files['build-info.json']))
        if metadata.get('revision') != source_sha or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', metadata.get('version', '')):
            raise ValueError('Candidate source/version identity is invalid')
        hashes = {'dist/player.js': metadata.get('bundleSha256')}
        providers = metadata.get('providerBundles')
        if not isinstance(providers, dict) or not providers:
            raise ValueError('Candidate lacks provider metadata')
        for entry in providers.values():
            name = member_path(entry['file'])
            if name in hashes or not re.fullmatch(r'dist/provider-[a-z0-9-]+\.js', name):
                raise ValueError('Invalid provider identity')
            hashes[name] = entry['sha256']
        if set(hashes) != {name for name in files if re.fullmatch(r'dist/(?:player|provider-[a-z0-9-]+)\.js', name)}:
            raise ValueError('Candidate provider inventory differs from metadata')
        for name, expected in hashes.items():
            if name not in files or hashlib.sha256(bundle.extractfile(files[name]).read()).hexdigest() != expected:
                raise ValueError('Candidate bundle hash differs from metadata')
        destination.mkdir(parents=True)
        try:
            for name, item in files.items():
                output = destination.joinpath(*PurePosixPath(name).parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(item) as source, output.open('xb') as target:
                    shutil.copyfileobj(source, target)
        except BaseException:
            shutil.rmtree(destination)
            raise
    identity = {'archive': archive.name, 'sha256': digest, 'size': archive.stat().st_size,
                'sourceSha': source_sha, 'version': metadata['version'], 'filesVerified': len(files),
                'releaseReceipt': release}
    diagnostics.mkdir(parents=True, exist_ok=True)
    (diagnostics / 'candidate.json').write_text(json.dumps(identity, indent=2) + '\n', encoding='utf-8')
    print(f"Verified Mode A {identity['version']}: {len(files)} packaged files, sha256 {digest}")
    return identity


if __name__ == '__main__':
    prepare(sys.argv[1], sys.argv[2], os.environ['CI_BROWSER_DIAGNOSTICS'], os.environ['GITHUB_SHA'], '--release' in sys.argv[3:])
