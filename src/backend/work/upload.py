"""Reject oversized streams before Django's temporary-file upload handler."""

from django.core.files.uploadhandler import FileUploadHandler, StopUpload

from . import services


class BoundedMaterialUpload(FileUploadHandler):
    """One file per request, with a byte bound independent of Content-Length."""

    def __init__(self, request):
        super().__init__(request)
        self.total = 0
        self.files = 0

    def new_file(self, *args, **kwargs):
        super().new_file(*args, **kwargs)
        self.files += 1
        if self.files > 1:
            self.request.work_upload_error = "one_file_required"
            raise StopUpload(connection_reset=False)

    def receive_data_chunk(self, raw_data, start):
        self.total += len(raw_data)
        if self.total > services.MAX_FILE_BYTES:
            self.request.work_upload_error = "file_too_large"
            raise StopUpload(connection_reset=False)
        return raw_data

    def file_complete(self, file_size):
        return None
