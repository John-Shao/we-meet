"""Create only the dedicated desktop public client; never modify other clients.

Reads KC_ADMIN_USER/KC_ADMIN_PASSWORD from environment or adjacent .env without
printing credentials. Default is read-only; --apply creates a missing client.
Existing incompatible clients fail closed and require explicit admin review.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--url', default='https://id.we-meet.online')
    parser.add_argument('--realm', default='meet')
    args = parser.parse_args()
    parsed = urllib.parse.urlparse(args.url)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('Expected an HTTPS origin')
    base = args.url.rstrip('/')
    env = {}
    env_file = Path(__file__).with_name('.env')
    if env_file.exists():
        for line in env_file.read_text(encoding='utf-8-sig').splitlines():
            key, sep, value = line.removeprefix('export ').partition('=')
            if sep and key.strip() in ('KC_ADMIN_USER', 'KC_ADMIN_PASSWORD'):
                parts = shlex.split(value, comments=True)
                env[key.strip()] = parts[0] if len(parts) == 1 else ''
    credentials = {key: os.environ.get(key) or env.get(key, '') for key in ('KC_ADMIN_USER', 'KC_ADMIN_PASSWORD')}
    if not all(credentials.values()) or any(value.startswith('REPLACE_') for value in credentials.values()):
        raise ValueError('Missing configured KC_ADMIN_USER / KC_ADMIN_PASSWORD')

    # Do not follow redirects with passwords or admin bearer credentials.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *unused):
            return None
    opener = urllib.request.build_opener(NoRedirect)

    def request(url, *, body=None, token=None, form=False):
        data = None if body is None else (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
        headers = {'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=20) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    token = request(base + '/realms/master/protocol/openid-connect/token', form=True, body={
        'client_id': 'admin-cli', 'grant_type': 'password',
        'username': credentials['KC_ADMIN_USER'], 'password': credentials['KC_ADMIN_PASSWORD'],
    })['access_token']
    endpoint = base + '/admin/realms/' + urllib.parse.quote(args.realm, safe='') + '/clients'
    desired = json.loads(Path(__file__).with_name('desktop-client.json').read_text(encoding='utf-8'))
    def lookup():
        return request(endpoint + '?clientId=desktop', token=token)
    existing = lookup()
    created = False
    if not existing:
        if not args.apply:
            print('desktop client is absent; --apply will create desktop-client.json in the selected realm')
            return
        request(endpoint, body=desired, token=token)
        existing = lookup()
        created = True
    if len(existing) != 1:
        raise ValueError('Expected exactly one desktop client')
    actual = request(endpoint + '/' + urllib.parse.quote(existing[0]['id'], safe=''), token=token)
    for key in ('clientId', 'enabled', 'protocol', 'publicClient', 'standardFlowEnabled', 'implicitFlowEnabled', 'directAccessGrantsEnabled', 'serviceAccountsEnabled', 'redirectUris', 'webOrigins'):
        if actual.get(key, False if isinstance(desired[key], bool) else []) != desired[key]:
            raise ValueError('Existing desktop client differs at ' + key + '; no existing configuration was modified')
    if actual.get('attributes', {}).get('pkce.code.challenge.method') != 'S256':
        raise ValueError('Existing desktop client does not require S256; no existing configuration was modified')
    print(json.dumps({'client': 'desktop', 'realm': args.realm, 'created': created, 'verified': True, 'pkce': 'S256', 'redirectUri': desired['redirectUris'][0]}))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print('Keycloak request failed with HTTP ' + str(error.code) + '; response body omitted', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
