"""Real HTTP regression tests for explicit consent and command authentication."""
import contextlib
import concurrent.futures
import http.client
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_proxy', ROOT / 'local_proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
TOKEN = 'a' * 64
OTHER_TOKEN = 'b' * 64
PATH = '/api/webhook/commands'
ORIGIN = 'http://player.example:8080'


@contextlib.contextmanager
def running_proxy(**options):
    server = proxy.CommandProxyServer(('127.0.0.1', 0), **options)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(server, method='GET', path=PATH, token=None, body=None, origin=None, headers=None):
    headers = dict(headers or {})
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token
    if origin is not None:
        headers['Origin'] = origin
    if isinstance(body, (dict, list)):
        body = json.dumps(body)
    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
        return response.status, dict(response.getheaders()), json.loads(data) if data else None
    finally:
        connection.close()


class LocalProxyTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(proxy.CommandProxyHandler, 'log_message')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_default_disabled_does_not_construct_or_bind_server(self):
        with mock.patch.object(proxy, 'CommandProxyServer') as server:
            self.assertEqual(proxy.main(['8081'], {}), 0)
            self.assertEqual(proxy.main(['8081'], {'OTTPLAY_QUEUE_HTTP_TOKEN': TOKEN}), 0)
            self.assertEqual(proxy.main(['8081'], {'OTTPLAY_QUEUE_HTTP_ENABLED': '1'}), 2)
            server.assert_not_called()
        result = subprocess.run([sys.executable, str(ROOT / 'local_proxy.py'), '0'],
                                env={}, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertIn('disabled', result.stdout)

    def test_disabled_or_invalid_token_cannot_use_embedded_listener(self):
        for options in ({}, {'token': TOKEN}, {'enabled': True}, {'enabled': True, 'token': 'short'}):
            with running_proxy(**options) as server:
                self.assertEqual(request(server, token=TOKEN)[0], 403)
                self.assertEqual(request(server, 'POST', token=TOKEN, body={'command': 'exit_player'})[0], 403)
                self.assertEqual(server.commands, [])

    def test_authorized_delivery_works_and_unauthorized_requests_cannot_enqueue_or_drain(self):
        with running_proxy(enabled=True, token=TOKEN) as server:
            for token in (None, OTHER_TOKEN):
                self.assertEqual(request(server, 'POST', token=token, body={'command': 'exit_player'})[0], 401)
            status, _, data = request(server, 'POST', token=TOKEN, body={'command': 'set_volume', 'volume': 15})
            self.assertEqual((status, data['queued']), (200, 1))
            for token in (None, OTHER_TOKEN):
                self.assertEqual(request(server, token=token)[0], 401)
            for query in ('?device_id=known', '?token=' + TOKEN, '?device_id=' + TOKEN):
                self.assertEqual(request(server, path=PATH + query)[0], 401)
            status, headers, data = request(server, token=TOKEN)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertEqual([(row['command'], row['volume']) for row in data], [('set_volume', 15)])
            self.assertEqual(request(server, token=TOKEN)[2], [])

    def test_device_code_selects_queue_without_broadcast_or_uuid_auth(self):
        with running_proxy(enabled=True, token=TOKEN) as first, running_proxy(enabled=True, token=OTHER_TOKEN) as second:
            self.assertEqual(request(first, 'POST', path='/webhook/notify', token=TOKEN,
                                     body={'command': 'random_channel'})[0], 200)
            self.assertEqual(request(second, token=TOKEN)[0], 401)
            self.assertEqual(request(second, token=OTHER_TOKEN)[2], [])
            # Legacy UUID is optional metadata: code-authenticated polling still receives the command.
            self.assertEqual(request(first, path='/webhook/poll?device_id=existing_uuid', token=TOKEN)[2][0]['command'],
                             'random_channel')

    def test_cors_requires_explicit_origin_and_preflight_has_no_token(self):
        with running_proxy(enabled=True, token=TOKEN, origins=[ORIGIN, '*']) as server:
            status, headers, _ = request(server, 'OPTIONS', origin=ORIGIN,
                                         headers={'Access-Control-Request-Method': 'GET',
                                                  'Access-Control-Request-Headers': 'Authorization'})
            self.assertEqual(status, 204)
            self.assertEqual(headers['Access-Control-Allow-Origin'], ORIGIN)
            self.assertIn('Authorization', headers['Access-Control-Allow-Headers'])
            self.assertEqual(request(server, origin=ORIGIN)[0], 401)
            self.assertEqual(request(server, token=TOKEN, origin=ORIGIN)[0], 200)
            for origin in ('https://evil.example', 'null'):
                self.assertEqual(request(server, 'OPTIONS', origin=origin)[0], 403)
                status, headers, _ = request(server, 'POST', token=TOKEN, origin=origin,
                                             body={'command': 'exit_player'})
                self.assertEqual(status, 403)
                self.assertNotIn('Access-Control-Allow-Origin', headers)
            self.assertEqual(server.commands, [])

    def test_invalid_bodies_and_framing_do_not_enqueue(self):
        with running_proxy(enabled=True, token=TOKEN) as server:
            for body in ('[]', 'null', '42', '{}', '{broken', '{"command":2}', '{"command":" "}'):
                self.assertEqual(request(server, 'POST', token=TOKEN, body=body)[0], 400)
            self.assertEqual(request(server, 'POST', token=TOKEN, body='x' * 65537)[0], 413)
            self.assertEqual(request(server, 'POST', token=TOKEN, body='{}',
                                     headers={'Transfer-Encoding': 'chunked'})[0], 400)
            self.assertEqual(server.commands, [])

    def test_duplicate_authorization_is_rejected_before_drain(self):
        with running_proxy(enabled=True, token=TOKEN) as server:
            request(server, 'POST', token=TOKEN, body={'command': 'random_channel'})
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                connection.putrequest('GET', PATH)
                connection.putheader('Authorization', 'Bearer ' + TOKEN)
                connection.putheader('Authorization', 'Bearer ' + OTHER_TOKEN)
                connection.endheaders()
                self.assertEqual(connection.getresponse().status, 401)
            finally:
                connection.close()
            self.assertEqual(len(request(server, token=TOKEN)[2]), 1)

    def test_queue_is_bounded_and_stale_commands_expire(self):
        with running_proxy(enabled=True, token=TOKEN) as server:
            for number in range(55):
                request(server, 'POST', token=TOKEN, body={'command': 'set_volume', 'volume': number, 'ts': 0})
            self.assertEqual(len(server.commands), 50)
            server.commands[0]['ts'] = time.time() - 61
            data = request(server, token=TOKEN)[2]
            self.assertEqual(len(data), 49)
            self.assertEqual(data[0]['volume'], 6)
            self.assertEqual(data[-1]['volume'], 54)

    def test_idle_connection_does_not_block_polling(self):
        accepted = threading.Event()
        original_accept = proxy.CommandProxyServer.get_request

        def accept(server):
            result = original_accept(server)
            accepted.set()
            return result

        with mock.patch.object(proxy.CommandProxyServer, 'get_request', accept):
            with running_proxy(enabled=True, token=TOKEN) as server:
                with socket.create_connection(server.server_address, timeout=2):
                    self.assertTrue(accepted.wait(2), 'idle connection was not accepted')
                    # request() times out after 3s; the idle socket times out after 5s.
                    self.assertEqual(request(server, token=TOKEN)[0], 200)

    def test_partial_post_does_not_block_polling_or_enqueue_early(self):
        authorized = threading.Event()
        original_authorize = proxy.CommandProxyHandler._authorize

        def authorize(handler):
            result = original_authorize(handler)
            if handler.command == 'POST':
                authorized.set()
            return result

        with mock.patch.object(proxy.CommandProxyHandler, '_authorize', authorize):
            with running_proxy(enabled=True, token=TOKEN) as server:
                connection = http.client.HTTPConnection(*server.server_address, timeout=3)
                try:
                    body = b'{"command":"random_channel"}'
                    connection.putrequest('POST', PATH)
                    connection.putheader('Authorization', 'Bearer ' + TOKEN)
                    connection.putheader('Content-Length', str(len(body)))
                    connection.endheaders(body[:1])
                    self.assertTrue(authorized.wait(2))
                    self.assertEqual(request(server, token=TOKEN)[2], [])
                    connection.send(body[1:])
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    response.read()
                    self.assertEqual(request(server, token=TOKEN)[2][0]['command'], 'random_channel')
                finally:
                    connection.close()

    def test_worker_limit_closes_excess_connections_and_recovers(self):
        workers_started = threading.Event()
        release_workers = threading.Event()
        workers_finished = threading.Event()
        count_lock = threading.Lock()
        counts = {'started': 0, 'finished': 0}
        original_handle = proxy.CommandProxyHandler.handle
        original_worker = proxy.CommandProxyServer.process_request_thread

        def handle(handler):
            with count_lock:
                counts['started'] += 1
                if counts['started'] == 2:
                    workers_started.set()
            release_workers.wait(3)
            original_handle(handler)

        def worker(server, *args):
            try:
                original_worker(server, *args)
            finally:
                with count_lock:
                    counts['finished'] += 1
                    if counts['finished'] == 2:
                        workers_finished.set()

        with mock.patch.object(proxy.CommandProxyServer, 'MAX_CONNECTIONS', 2), \
                mock.patch.object(proxy.CommandProxyHandler, 'handle', handle), \
                mock.patch.object(proxy.CommandProxyServer, 'process_request_thread', worker):
            with running_proxy(enabled=True, token=TOKEN) as server:
                try:
                    with contextlib.ExitStack() as clients:
                        for _ in range(2):
                            clients.enter_context(socket.create_connection(server.server_address, timeout=2))
                        self.assertTrue(workers_started.wait(2))
                        with socket.create_connection(server.server_address, timeout=2) as excess:
                            self.assertEqual(excess.recv(1), b'')
                        self.assertEqual(counts['started'], 2)
                finally:
                    release_workers.set()
                self.assertTrue(workers_finished.wait(2), 'worker slots were not released')
                self.assertEqual(request(server, token=TOKEN)[0], 200)

    def test_failed_worker_start_releases_its_slot(self):
        with mock.patch.object(proxy.CommandProxyServer, 'MAX_CONNECTIONS', 1):
            with proxy.CommandProxyServer(('127.0.0.1', 0)) as server:
                with mock.patch.object(proxy.http.server.ThreadingHTTPServer, 'process_request',
                                       side_effect=RuntimeError('cannot start worker')) as start:
                    for _ in range(2):
                        with self.assertRaisesRegex(RuntimeError, 'cannot start worker'):
                            server.process_request(mock.Mock(), ('127.0.0.1', 0))
                    self.assertEqual(start.call_count, 2)

    def test_enqueue_during_drain_is_not_lost(self):
        scanning = threading.Event()
        producer_started = threading.Event()
        producer_done = threading.Event()

        class DelayedTimestamp:
            def __gt__(self, _cutoff):
                # Force a producer to arrive while the consumer filters the
                # snapshot. Without atomic queue operations its new command
                # would be discarded by the consumer's subsequent clear.
                scanning.set()
                if not producer_started.wait(2):
                    raise AssertionError('producer did not start')
                producer_done.wait(0.1)
                return True

        with proxy.CommandProxyServer(('127.0.0.1', 0)) as server:
            server.commands = [{'command': 'first', 'ts': DelayedTimestamp()}]

            def enqueue():
                producer_started.set()
                server.enqueue_command({'command': 'second'})
                producer_done.set()

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
                drain = workers.submit(server.drain_commands)
                self.assertTrue(scanning.wait(2))
                producer = workers.submit(enqueue)
                self.assertEqual([row['command'] for row in drain.result(timeout=3)], ['first'])
                producer.result(timeout=3)
            self.assertEqual([row['command'] for row in server.drain_commands()], ['second'])

    def test_concurrent_pollers_deliver_each_command_once(self):
        with running_proxy(enabled=True, token=TOKEN) as server:
            for number in range(40):
                self.assertEqual(request(server, 'POST', token=TOKEN,
                                         body={'command': 'set_volume', 'volume': number})[0], 200)
            start = threading.Barrier(4)

            def poll():
                start.wait(timeout=3)
                status, _, rows = request(server, token=TOKEN)
                self.assertEqual(status, 200)
                return rows

            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
                polls = [workers.submit(poll) for _ in range(4)]
                volumes = [row['volume'] for poll in polls for row in poll.result(timeout=3)]
            self.assertEqual(sorted(volumes), list(range(40)))

    def test_handler_never_serves_files(self):
        with running_proxy(enabled=True, token=TOKEN) as server:
            self.assertEqual(request(server, path='/local_proxy.py', token=TOKEN)[0], 404)
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                connection.request('HEAD', '/local_proxy.py')
                self.assertEqual(connection.getresponse().status, 501)
            finally:
                connection.close()

    def test_real_smoke_script_delivers_and_drains_authenticated_commands(self):
        with running_proxy(enabled=True, token=TOKEN) as server:
            env = {key: value for key, value in os.environ.items() if key not in {
                'QUEUE_HTTP_TOKEN', 'OTTPLAY_QUEUE_HTTP_TOKEN', 'DEVICE_ID', 'COMMAND_JSON', 'BACKEND_FILTER',
            }}
            env.update(OTTPLAY_QUEUE_HTTP_TOKEN=TOKEN, BASE_URL=f'http://127.0.0.1:{server.server_port}')
            result = subprocess.run(['bash', str(ROOT / 'scripts/smoke-command-queue.sh'), '--aliases'],
                                    env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('PASS: command queue POST', result.stdout)
            self.assertNotIn(TOKEN, result.stdout + result.stderr)
            self.assertEqual(server.commands, [])


if __name__ == '__main__':
    unittest.main()
