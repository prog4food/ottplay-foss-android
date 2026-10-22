#!/usr/bin/env python3
"""Resolve native backup/share configuration against concrete credential/capture paths."""
from pathlib import Path, PurePosixPath
import xml.etree.ElementTree as ET
import unittest

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / 'android/app/src/main'
NS = '{http://schemas.android.com/apk/res/android}'

class NativeSecurityConfig(unittest.TestCase):
    def setUp(self):
        self.manifest = ET.parse(MAIN/'AndroidManifest.xml').getroot()
        self.app = self.manifest.find('application')
    def resource(self, reference):
        self.assertTrue(reference.startswith('@xml/'))
        return ET.parse(MAIN/'res/xml'/(reference[5:]+'.xml')).getroot()
    def test_private_profile_excluded_from_both_backup_protocols(self):
        old = self.resource(self.app.get(NS+'fullBackupContent'))
        new = self.resource(self.app.get(NS+'dataExtractionRules'))
        private_files = [('root', 'app_webview/Default/Local Storage/leveldb/000001.log'),
                         ('root', 'app_webview/Default/Cookies'),
                         ('file', 'provider.json'), ('database', 'credentials.db'),
                         ('sharedpref', 'settings.xml'), ('external', 'playlist.m3u')]
        for rules in [old, new.find('cloud-backup'), new.find('device-transfer')]:
            for domain, name in private_files:
                with self.subTest(protocol=rules.tag, domain=domain, path=name):
                    excluded = any(rule.get('domain') == domain and
                        (rule.get('path') == '.' or PurePosixPath(name).is_relative_to(rule.get('path')))
                        for rule in rules.findall('exclude'))
                    self.assertTrue(excluded, 'Credentials must not transfer through Android backup')
    def test_file_provider_only_grants_actual_capacitor_capture_directory(self):
        provider = self.app.find('provider')
        self.assertEqual(provider.get(NS+'exported'), 'false')
        metadata = provider.find('meta-data')
        paths = list(self.resource(metadata.get(NS+'resource')))
        capture_source = (ROOT/'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeWebChromeClient.java').read_text()
        self.assertIn('getExternalFilesDir(Environment.DIRECTORY_PICTURES)', capture_source)
        samples = [('external-files-path', 'Pictures/JPEG_20260912.jpg', True),
                   ('external-files-path', 'credentials.json', False),
                   ('external-path', 'Pictures/private.jpg', False),
                   ('cache-path', 'epg-cache.json', False)]
        for domain, name, expected in samples:
            grant = any(path.tag == domain and PurePosixPath(name).is_relative_to(path.get('path')) for path in paths)
            self.assertEqual(grant, expected, name)
        self.assertEqual(provider.get(NS+'grantUriPermissions'), 'true')
    def test_http_is_explicit_full_only_and_media_permission_is_minimal(self):
        for edition, value in [('full','true'), ('play','false')]:
            application = ET.parse(ROOT/f'android/app/src/{edition}/AndroidManifest.xml').find('application')
            self.assertEqual(application.get(NS+'usesCleartextTraffic'), value)
        permissions = {x.get(NS+'name') for x in self.manifest.findall('uses-permission')}
        self.assertNotIn('android.permission.POST_NOTIFICATIONS', permissions)
        self.assertIn('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK', permissions)
        service = self.app.find('service')
        self.assertEqual(service.get(NS+'exported'), 'false')
        self.assertEqual(service.get(NS+'foregroundServiceType'), 'mediaPlayback')

    def test_home_requires_explicit_enablement_and_keeps_normal_launcher(self):
        intent = 'android.intent.'
        components = list(self.app.findall('activity')) + list(self.app.findall('activity-alias'))

        def resolve(category, enabled=()):
            matches = []
            for component in components:
                name = component.get(NS+'name')
                if component.get(NS+'enabled', 'true') == 'false' and name not in enabled:
                    continue
                if component.get(NS+'exported') != 'true':
                    continue
                for rule in component.findall('intent-filter'):
                    actions = {node.get(NS+'name') for node in rule.findall('action')}
                    categories = {node.get(NS+'name') for node in rule.findall('category')}
                    required = {intent+'category.'+category}
                    if category == 'HOME':
                        required.add(intent+'category.DEFAULT')
                    if intent+'action.MAIN' in actions and required <= categories:
                        matches.append(name)
            return matches

        self.assertEqual(resolve('HOME'), [])
        self.assertEqual(resolve('LAUNCHER'), ['.MainActivity'])
        self.assertEqual(resolve('HOME', enabled=['.HomeActivity']), ['.HomeActivity'])
        self.assertEqual(resolve('LAUNCHER', enabled=['.HomeActivity']), ['.MainActivity'])
        alias = next(node for node in self.app.findall('activity-alias')
                     if node.get(NS+'name') == '.HomeActivity')
        target = next(node for node in self.app.findall('activity')
                      if node.get(NS+'name') == alias.get(NS+'targetActivity'))
        self.assertEqual(target.get(NS+'name'), '.MainActivity')
        self.assertLess(list(self.app).index(target), list(self.app).index(alias))
        self.assertEqual(target.get(NS+'launchMode'), 'singleTask')
        permissions = {node.get(NS+'name') for node in self.manifest.findall('uses-permission')}
        self.assertTrue(permissions.isdisjoint({
            'android.permission.RECEIVE_BOOT_COMPLETED',
            'android.permission.SYSTEM_ALERT_WINDOW',
        }))

    def test_home_setup_is_explicit_only_and_can_see_alternate_home_apps(self):
        setup = next(node for node in self.app.findall('activity')
                     if node.get(NS+'name') == '.HomeSetupActivity')
        self.assertEqual(setup.get(NS+'exported'), 'true')
        self.assertEqual(setup.findall('intent-filter'), [])
        self.assertEqual(setup.get(NS+'excludeFromRecents'), 'true')
        queries = self.manifest.find('queries').findall('intent')
        self.assertTrue(any(
            {node.get(NS+'name') for node in query.findall('action')} == {'android.intent.action.MAIN'}
            and {node.get(NS+'name') for node in query.findall('category')} == {'android.intent.category.HOME'}
            for query in queries))
        resources = []
        for language in ('values', 'values-ru'):
            strings = ET.parse(MAIN/'res'/language/'strings.xml').getroot()
            resources.append({node.get('name'): node.text for node in strings.findall('string')
                              if node.get('name', '').startswith('home_setup_')})
        self.assertEqual(resources[0].keys(), resources[1].keys())
        self.assertTrue(resources[0])
        self.assertTrue(all(resources[0].values()) and all(resources[1].values()))

if __name__ == '__main__': unittest.main()
