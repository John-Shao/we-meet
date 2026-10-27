"""Bridge the D1 provider context (work_worker) to the D-03 B cipher."""

from work.api.context import fetch_one, role_cursor
from work.runtime.contracts.model_gateway import ModelGatewayError, ProviderContext
from work.security import credential_cipher


def resolve_provider_context(org_id: str) -> ProviderContext:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT * FROM work.resolve_provider_context(%s)",
            [org_id],
        )
        row = fetch_one(cursor)
    if row is None:
        raise ModelGatewayError("provider_not_configured")
    return ProviderContext(
        org_id=org_id,
        provider=row["provider"],
        model=row["model"],
        region=row["region"],
        endpoint=row["endpoint"],
        credential_mode=row["credential_mode"],
        role_ref=row["role_ref"],
        secret_ciphertext=(
            bytes(row["secret_ciphertext"]) if row["secret_ciphertext"] else None
        ),
        wrapped_dek=bytes(row["wrapped_dek"]) if row["wrapped_dek"] else None,
        kms_key_ref=row["kms_key_ref"],
    )


def decrypt_secret(context: ProviderContext) -> str:
    if context.credential_mode != "managed_key" or not context.secret_ciphertext:
        raise ModelGatewayError("credential_not_decryptable")
    plaintext = credential_cipher.decrypt(context.org_id, context.secret_ciphertext)
    return plaintext.decode("utf-8")
