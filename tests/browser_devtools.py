"""Real Chromium smoke test against an isolated in-memory test application.

Uses the browser's localhost DevTools socket; no browser packages or profiles
are installed or changed. Credentials and products belong only to the fixture.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import threading
import time
from urllib.parse import urlsplit

import httpx
import pytest
import uvicorn




class DevTools:
    def __init__(self, url):
        target = urlsplit(url)
        self.socket = socket.create_connection((target.hostname, target.port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (f'GET {target.path} HTTP/1.1\r\nHost: {target.netloc}\r\n'
                   f'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
                   'Sec-WebSocket-Version: 13\r\n\r\n')
        self.socket.sendall(request.encode())
        response = b''
        while not response.endswith(b'\r\n\r\n'):
            response += self.socket.recv(1)
        accept = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert response.startswith(b'HTTP/1.1 101 ') and accept in response
        self.sequence = 0

    def read(self, length):
        value = b''
        while len(value) < length:
            chunk = self.socket.recv(length-len(value))
            if not chunk:
                raise RuntimeError('DevTools socket closed')
            value += chunk
        return value

    def call(self, method, params=None):
        self.sequence += 1
        data = json.dumps({'id':self.sequence,'method':method,'params':params or {}}).encode()
        mask = os.urandom(4)
        size = len(data)
        header = bytes([0x81, 0x80 | size]) if size < 126 else bytes([0x81,0xfe])+struct.pack('!H',size)
        self.socket.sendall(header+mask+bytes(c ^ mask[i % 4] for i,c in enumerate(data)))
        message = b''
        while True:
            first, second = self.read(2)
            size = second & 127
            if size == 126:
                size = struct.unpack('!H',self.read(2))[0]
            elif size == 127:
                size = struct.unpack('!Q',self.read(8))[0]
            assert not second & 128
            payload = self.read(size)
            assert first & 15 in (0,1)
            message += payload
            if first & 128:
                reply = json.loads(message)
                message = b''
                if reply.get('id') == self.sequence:
                    assert 'error' not in reply
                    return reply.get('result', {})

    def evaluate(self, code):
        result = self.call('Runtime.evaluate', {'expression':code,'returnByValue':True,'awaitPromise':True})
        assert 'exceptionDetails' not in result, result.get('exceptionDetails')
        return result['result'].get('value')


def wait_for(test):
    deadline = time.monotonic()+15
    while time.monotonic() < deadline:
        try:
            if test():
                return
        except PermissionError:
            # Windows may briefly deny a read while the isolated server atomically replaces its JSON file.
            pass
        time.sleep(.1)
    raise AssertionError('Browser condition timed out')
