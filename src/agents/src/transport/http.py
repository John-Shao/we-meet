"""Shared HTTP transport for authenticated backend calls."""

import urllib.request


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the internal agent credential to a redirected destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: PLR0913 -- urllib redirect handler signature
        return None


def open_backend(request, *, timeout):
    """Open an internal request without forwarding credentials on redirects."""
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)
