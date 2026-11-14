"""Enable OIDC back-channel logout on the meet realm's Host clients.

Work's Bearer-plane auth epoch (control-design §1.1) must advance on Keycloak
session revocation, password/credential change and admin revocation. Keycloak
delivers those events as a back-channel logout token, but only when the client has
a ``backchannel.logout.url`` attribute pointing at the Host receiver
(``/api/v1.0/backchannel-logout/``, see core.authentication.views). The production
clients currently have no such URL, so the Host receiver never gets called.

This script closes that emission-side gap. It is read-only by default and prints
the planned change; ``--apply`` performs a GET -> merge -> PUT that touches ONLY
``attributes["backchannel.logout.url"]``, preserving every other field. (This
Keycloak version enables back-channel logout purely via that attribute; the
top-level ``backchannelLogout`` is not a writable representation field.) It never
creates clients, never modifies unrelated clients, and never prints credentials or
the admin token. Running it against production is a production write and requires
separate authorization.
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


LOGOUT_PATH = "/api/v1.0/backchannel-logout/"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--url', default='https://id.we-meet.online')
    parser.add_argument('--realm', default='meet')
    parser.add_argument('--backend-base-url', default='https://meet.we-meet.online')
    parser.add_argument('--clients', default='desktop,meet')
    args = parser.parse_args()
    parsed = urllib.parse.urlparse(args.url)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('Expected an HTTPS origin')
    backend = urllib.parse.urlparse(args.backend_base_url)
    if backend.scheme != 'https' or backend.netloc == '' or backend.path not in ('', '/'):
        raise ValueError('Expected an HTTPS backend origin')
    base = args.url.rstrip('/')
    logout_url = args.backend_base_url.rstrip('/') + LOGOUT_PATH

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

    def request(url, *, body=None, token=None, form=False, method=None):
        data = None if body is None else (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
        headers = {'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with opener.open(req, timeout=25) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    token = request(base + '/realms/master/protocol/openid-connect/token', form=True, body={
        'client_id': 'admin-cli', 'grant_type': 'password',
        'username': credentials['KC_ADMIN_USER'], 'password': credentials['KC_ADMIN_PASSWORD'],
    })['access_token']
    endpoint = base + '/admin/realms/' + urllib.parse.quote(args.realm, safe='') + '/clients'

    for client_id in [c.strip() for c in args.clients.split(',') if c.strip()]:
        matches = request(endpoint + '?clientId=' + urllib.parse.quote(client_id, safe=''), token=token)
        if not matches:
            raise ValueError(client_id + ' client is absent; this script never creates clients')
        if len(matches) != 1:
            raise ValueError('Expected exactly one ' + client_id + ' client')
        client_url = endpoint + '/' + urllib.parse.quote(matches[0]['id'], safe='')
        actual = request(client_url, token=token)
        attrs_before = actual.get('attributes') or {}
        before = {
            'backchannel.logout.url': attrs_before.get('backchannel.logout.url'),
            'backchannel.logout.session.required': attrs_before.get('backchannel.logout.session.required'),
        }
        if not args.apply:
            print(json.dumps({'client': client_id, 'mode': 'read-only', 'current': before,
                              'planned': {'backchannel.logout.url': logout_url}},
                             ensure_ascii=False))
            continue
        # GET -> merge -> PUT: touch only backchannel.logout.url, which is what
        # enables back-channel logout in this Keycloak version.
        attrs = actual.get('attributes') or {}
        attrs['backchannel.logout.url'] = logout_url
        actual['attributes'] = attrs
        request(client_url, body=actual, token=token, method='PUT')
        verified = request(client_url, token=token)
        after_attrs = verified.get('attributes') or {}
        if after_attrs.get('backchannel.logout.url') != logout_url:
            raise ValueError(client_id + ' back-channel logout did not verify after PUT')
        print(json.dumps({'client': client_id, 'mode': 'applied', 'before': before,
                          'backchannel.logout.url': logout_url}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print('Keycloak request failed with HTTP ' + str(error.code) + '; response body omitted', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)