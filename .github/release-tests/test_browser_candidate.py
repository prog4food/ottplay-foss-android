"""Candidate bytes, source identity and reusable browser-gate regression checks."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('candidate', ROOT / 'scripts/prepare_browser_candidate.py')
CANDIDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CANDIDATE)
SHA = 'a' * 40


class CandidateTests(unittest.TestCase):
    def test_rejects_limits_before_scanning_the_remaining_archive(self):
        class GuardedArchive:
            def __init__(self, count, size):
                self.count, self.size, self.visited = count, size, 0

            def __iter__(self):
                for index in range(self.count):
                    self.visited += 1
                    item = tarfile.TarInfo(f'entry-{index}')
                    item.size = self.size
                    yield item
                raise AssertionError('Scanned past the first over-limit member')

            def getmembers(self):
                return list(self)

        for count, size in [(10_001, 0), (2, CANDIDATE.MAX_UNPACKED_BYTES), (1, -1)]:
            with self.subTest(count=count, size=size):
                archive = GuardedArchive(count, size)
                with self.assertRaisesRegex(ValueError, 'invalid unpacked size'):
                    CANDIDATE.archive_files(archive)
                self.assertEqual(archive.visited, count)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        self.payload = {'index.html': b'<html>Player</html>', 'dist/player.js': b'player()',
                        'dist/provider-plex.js': b'plex()', 'devices/pc2/device.js': b'pc2()'}
        self.metadata = {'revision': SHA, 'version': '1.2.3',
                         'bundleSha256': hashlib.sha256(self.payload['dist/player.js']).hexdigest(),
                         'providerBundles': {'plex': {'file': 'dist/provider-plex.js',
                             'sha256': hashlib.sha256(self.payload['dist/provider-plex.js']).hexdigest()}}}

    def archive(self, extra=None):
        payload = {**self.payload, 'build-info.json': json.dumps(self.metadata).encode()}
        archive = self.artifacts / 'ottplay-foss-modea.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            for name, data in payload.items():
                item = tarfile.TarInfo('./' + name)
                item.size = len(data)
                bundle.addfile(item, io.BytesIO(data))
            if extra:
                bundle.addfile(extra, io.BytesIO(b'x') if extra.isfile() else None)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.artifacts / 'ottplay-foss-modea.sha256').write_text(digest + '  ' + archive.name + '\n')
        (self.artifacts / 'release-inputs-web.json').write_text(json.dumps({
            'source_sha': SHA, 'artifacts': [{'name': archive.name, 'sha256': digest,
                                           'size': archive.stat().st_size}]}))
        return archive

    def prepare(self, release=True):
        return CANDIDATE.prepare(self.artifacts, self.root / 'web', self.root / 'evidence', SHA, release)

    def test_exact_candidate_bytes_in_both_modes(self):
        self.archive()
        for release in [False, True]:
            with self.subTest(release=release):
                dest = self.root / ('web-' + str(release))
                identity = CANDIDATE.prepare(self.artifacts, dest, self.root / 'evidence', SHA, release)
                self.assertEqual(identity['filesVerified'], 5)
                self.assertEqual(identity['sourceSha'], SHA)
                for name, data in self.payload.items():
                    self.assertEqual((dest / name).read_bytes(), data)

    def test_wrong_source_and_bundle_hash(self):
        original = copy.deepcopy(self.metadata)
        for field in ['revision', 'bundleSha256']:
            with self.subTest(field=field):
                self.metadata = {**original, field: 'b' * 64}
                self.archive()
                with self.assertRaises(ValueError): self.prepare()

    def test_receipt_required_and_binds_archive(self):
        self.archive()
        receipt = self.artifacts / 'release-inputs-web.json'
        receipt.unlink()
        with self.assertRaises(ValueError): self.prepare()
        self.archive()
        value = json.loads(receipt.read_text())
        value['artifacts'][0]['sha256'] = 'b' * 64
        receipt.write_text(json.dumps(value))
        with self.assertRaises(ValueError): self.prepare()

    def test_archive_checksum_and_symlink_rejected(self):
        archive = self.archive()
        archive.write_bytes(archive.read_bytes() + b'changed')
        with self.assertRaises(ValueError): self.prepare()
        self.archive()
        actual = self.root / 'outside.tar.gz'
        archive.rename(actual)
        archive.symlink_to(actual)
        with self.assertRaises(ValueError): self.prepare()

    def test_archive_traversal_links_duplicates_rejected(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('dir\\escape', tarfile.REGTYPE), ('linked', tarfile.SYMTYPE),
                           ('hard', tarfile.LNKTYPE), ('INDEX.HTML', tarfile.REGTYPE)]:
            with self.subTest(name=name):
                item = tarfile.TarInfo(name)
                item.type = kind
                item.size = 1 if kind == tarfile.REGTYPE else 0
                item.linkname = '../escape' if kind != tarfile.REGTYPE else ''
                self.archive(item)
                with self.assertRaises(ValueError): self.prepare()
                self.assertFalse((self.root / 'web').exists())

    def test_incomplete_provider_inventory_rejected(self):
        self.payload['dist/provider-extra.js'] = b'extra()'
        self.archive()
        with self.assertRaises(ValueError): self.prepare()

    def test_existing_destination_never_overwritten(self):
        self.archive()
        (self.root / 'web').mkdir()
        with self.assertRaises(ValueError): self.prepare()

    def test_source_and_release_gates_use_exact_built_artifact(self):
        for filename, job_id in [('ci.yml', 'browser-compatibility'), ('release-build.yml', 'browser-release')]:
            workflow = yaml.safe_load((ROOT / '.github/workflows' / filename).read_text())
            job = workflow['jobs'][job_id]
            self.assertEqual(job['needs'], 'build')
            self.assertIn('/typescript-ci.yml@', job['uses'])
            self.assertEqual(job['with']['browser-artifact-id'], '${{ needs.build.outputs.browser-artifact-id }}')
            self.assertFalse(job['with']['run-node-ci'])
            self.assertEqual(job['with']['browser-test-command'], 'node scripts/browser-acceptance.cjs')
            self.assertNotIn('npm run build', job['with']['browser-prepare-command'])
            expected_extended = "${{ inputs.channel == 'rc' || inputs.channel == 'stable' }}" if job_id == 'browser-release' else False
            self.assertEqual(job['with'].get('browser-extended', False), expected_extended)
            self.assertEqual(job['with'].get('browser-release-channel', ''), '${{ inputs.channel }}' if job_id == 'browser-release' else '')
            self.assertEqual('--release' in job['with']['browser-prepare-command'], job_id == 'browser-release')
            if job_id == 'browser-release':
                self.assertEqual(job['with']['browser-evidence-prefix'], 'browser-release')
