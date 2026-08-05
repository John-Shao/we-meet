"""Group bot management — ``/api/v1.0/im/bots/``."""

# pylint: disable=redefined-outer-name,unused-argument,protected-access

import json
from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services.jusi_im import JusiImTokenResponse

pytestmark = pytest.mark.django_db

CID = "11111111-1111-4111-8111-111111111111"
BASE = "/api/v1.0/im/bots/"


@pytest.fixture
def organization():
    """record_audit is org-scoped and no-ops without one."""
    return OrganizationFactory()


@pytest.fixture
def owner(organization):
    user = UserFactory()
    MembershipFactory(user=user, organization=organization)
    return user


@pytest.fixture
def member(organization):
    user = UserFactory()
    MembershipFactory(user=user, organization=organization)
    return user


@pytest.fixture
def jusi(owner, member):
    """Stub jusi: token issuing + the roster that decides who may do what."""
    with mock.patch("core.api.im.JusiImAdminClient") as ctor, mock.patch(
        "core.api.im_bots.im_bots.ensure_member"
    ), mock.patch("core.api.im_bots.im_bots.resolve_bot_uid") as resolve, mock.patch(
        "core.api.im_bots.utils.render_bot_avatar_swatch", return_value=""
    ), mock.patch(
        "core.api.im_bots.utils.generate_profile_image_get_url", return_value=""
    ):
        instance = mock.Mock()
        ctor.return_value = instance
        def _resolve_bot_uid(_client, bot):
            """Mirror the real function: mint AND backfill, or the delete path
            has no uid to take out of the conversation."""
            uid = f"01900000-0000-7000-8000-{bot.pk.hex[:12]}"
            models.ImBot.objects.filter(pk=bot.pk).update(im_uid=uid)
            bot.im_uid = uid
            return uid

        resolve.side_effect = _resolve_bot_uid

        # Keyed the way the code identifies a user (sub, falling back to pk) —
        # not by pk, or the owner check silently fails for everyone.
        def external_id(user):
            return str(user.sub) if getattr(user, "sub", None) else str(user.pk)

        uids = {
            external_id(owner): "01900000-0000-7000-8000-000000000001",
            external_id(member): "01900000-0000-7000-8000-000000000002",
        }

        def _issue(external_id, ttl_seconds):
            return JusiImTokenResponse(
                uid=uids.get(external_id, "01900000-0000-7000-8000-00000000000f"),
                token=f"token-for-{external_id}",
                expires_at=1781700000,
            )

        instance.issue_token.side_effect = _issue
        instance.get_members.return_value = [
            {"uid": uids[external_id(owner)], "role": "owner"},
            {"uid": uids[external_id(member)], "role": "member"},
        ]
        yield instance


def client_for(user):
    api = APIClient()
    api.force_login(user)
    return api


def create_bot(user, **overrides):
    payload = {"cid": CID, "name": "构建通知", "description": "CI 构建结果推送"}
    payload.update(overrides)
    return client_for(user).post(BASE, payload, format="json")


# ---- create ------------------------------------------------------------------


def test_owner_can_create_a_bot(owner, jusi):
    response = create_bot(owner)
    assert response.status_code == 201, response.data
    body = response.data
    assert body["name"] == "构建通知"
    assert body["kind"] == "custom"
    assert body["webhook_url"].endswith(
        models.ImBotInstallation.objects.get().webhook_token
    )
    assert "/api/bot/v1/hook/" in body["webhook_url"]


def test_creating_a_bot_joins_it_to_the_conversation(owner, jusi):
    """A bot that is not a member gets its sender silently rewritten by jusi."""
    with mock.patch("core.api.im_bots.im_bots.ensure_member") as ensure:
        create_bot(owner)
    assert ensure.call_args[0][1] == CID
    assert ensure.call_args[1]["force"] is True


def test_creating_a_bot_leaves_a_system_trace_in_the_group(owner, jusi):
    create_bot(owner)
    body = jusi.post_message.call_args[1]["body"]
    assert "添加了机器人" in body
    assert jusi.post_message.call_args[1]["content_type"] == "system"


def test_non_owner_cannot_create_a_bot(member, jusi):
    """A webhook is a write credential for the whole group."""
    response = create_bot(member)
    assert response.status_code == 403
    assert not models.ImBot.objects.filter(kind=models.ImBotKindChoices.CUSTOM).exists()


def test_anonymous_cannot_create_a_bot():
    assert APIClient().post(BASE, {"cid": CID, "name": "x"}, format="json").status_code == 401


def test_creation_requires_a_name(owner, jusi):
    assert create_bot(owner, name="   ").status_code == 400


def test_creation_rejects_an_overlong_name(owner, jusi):
    assert create_bot(owner, name="名" * 33).status_code == 400


def test_creation_rejects_a_foreign_avatar_key(owner, jusi):
    """Otherwise a bot could wear somebody's profile picture."""
    response = create_bot(owner, avatar_key=f"{owner.pk}/abcdef.png")
    assert response.status_code == 400


def test_creation_accepts_our_own_avatar_key(owner, jusi):
    assert create_bot(owner, avatar_key="bot/abcdef1234.png").status_code == 201


def test_creation_rejects_a_malformed_ip_allowlist(owner, jusi):
    assert create_bot(owner, ip_allowlist=["not-an-ip"]).status_code == 400


def test_creation_accepts_cidr_entries(owner, jusi):
    response = create_bot(owner, ip_allowlist=["10.0.0.0/8", "203.0.113.9"])
    assert response.status_code == 201
    assert response.data["ip_allowlist"] == ["10.0.0.0/8", "203.0.113.9"]


def test_creation_caps_the_number_of_bots_per_conversation(owner, jusi, settings):
    settings.BOT_CONFIGURATION = {
        **settings.BOT_CONFIGURATION,
        "max_bots_per_conversation": 1,
    }
    assert create_bot(owner).status_code == 201
    assert create_bot(owner, name="第二个").status_code == 400


def test_each_bot_gets_a_distinct_credential(owner, jusi):
    first = create_bot(owner).data
    second = create_bot(owner, name="部署通知").data
    assert first["webhook_url"] != second["webhook_url"]


# ---- list / read -------------------------------------------------------------


def test_members_see_the_bot_but_not_its_credentials(owner, member, jusi):
    create_bot(owner)
    response = client_for(member).get(f"{BASE}?cid={CID}")
    assert response.status_code == 200
    (row,) = response.data
    assert row["name"] == "构建通知"
    assert row["webhook_url"] is None
    assert row["keywords"] is None


def test_owner_sees_the_credentials_in_the_list(owner, jusi):
    create_bot(owner)
    (row,) = client_for(owner).get(f"{BASE}?cid={CID}").data
    assert "/api/bot/v1/hook/" in row["webhook_url"]


def test_listing_requires_a_cid(owner, jusi):
    assert client_for(owner).get(BASE).status_code == 400


def test_non_members_cannot_list(owner, jusi):
    """jusi refuses the roster to non-members, which is how we know."""
    from core.services.jusi_im import JusiImBadResponseError

    create_bot(owner)
    outsider = UserFactory()
    jusi.get_members.side_effect = JusiImBadResponseError("403")
    assert client_for(outsider).get(f"{BASE}?cid={CID}").status_code == 403


def test_secret_is_not_in_the_list_payload(owner, jusi):
    create_bot(owner)
    (row,) = client_for(owner).get(f"{BASE}?cid={CID}").data
    assert "signing_secret" not in row


def test_owner_can_read_the_secret_and_it_is_audited(owner, jusi):
    install_id = create_bot(owner).data["id"]
    response = client_for(owner).get(f"{BASE}{install_id}/secret/")
    assert response.status_code == 200
    assert response.data["secret"]
    assert models.AuditLog.objects.filter(
        action=models.AuditActionChoices.BOT_WEBHOOK_VIEW
    ).exists()


def test_non_owner_cannot_read_the_secret(owner, member, jusi):
    install_id = create_bot(owner).data["id"]
    assert client_for(member).get(f"{BASE}{install_id}/secret/").status_code == 403


# ---- update ------------------------------------------------------------------


def test_owner_can_rename_and_set_gates(owner, jusi):
    install_id = create_bot(owner).data["id"]
    response = client_for(owner).patch(
        f"{BASE}{install_id}/",
        {"name": "部署通知", "sign_verify_enabled": True, "keywords": ["部署"]},
        format="json",
    )
    assert response.status_code == 200
    assert response.data["name"] == "部署通知"
    assert response.data["sign_verify_enabled"] is True
    assert response.data["keywords"] == ["部署"]


def test_non_owner_cannot_update(owner, member, jusi):
    install_id = create_bot(owner).data["id"]
    response = client_for(member).patch(
        f"{BASE}{install_id}/", {"name": "改名"}, format="json"
    )
    assert response.status_code == 403


def test_update_rejects_too_many_keywords(owner, jusi):
    install_id = create_bot(owner).data["id"]
    response = client_for(owner).patch(
        f"{BASE}{install_id}/", {"keywords": [str(i) for i in range(11)]}, format="json"
    )
    assert response.status_code == 400


# ---- rotation ----------------------------------------------------------------


def test_resetting_the_secret_changes_it(owner, jusi):
    install_id = create_bot(owner).data["id"]
    before = client_for(owner).get(f"{BASE}{install_id}/secret/").data["secret"]
    after = client_for(owner).post(f"{BASE}{install_id}/reset-secret/").data["secret"]
    assert before != after


def test_resetting_the_token_invalidates_the_old_url(owner, jusi):
    created = create_bot(owner).data
    old_token = created["webhook_url"].rsplit("/", 1)[-1]
    install_id = created["id"]
    new_url = client_for(owner).post(f"{BASE}{install_id}/reset-token/").data["webhook_url"]
    assert new_url != created["webhook_url"]

    response = APIClient().post(
        f"/api/bot/v1/hook/{old_token}",
        {"msg_type": "text", "content": {"text": "hi"}},
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["code"] == 19001


def test_non_owner_cannot_rotate(owner, member, jusi):
    install_id = create_bot(owner).data["id"]
    assert client_for(member).post(f"{BASE}{install_id}/reset-secret/").status_code == 403


# ---- delete ------------------------------------------------------------------


def test_owner_can_remove_a_bot(owner, jusi):
    install_id = create_bot(owner).data["id"]
    assert client_for(owner).delete(f"{BASE}{install_id}/").status_code == 204
    assert not models.ImBotInstallation.objects.exists()
    assert not models.ImBot.objects.filter(kind="custom").exists()


def test_removing_a_bot_takes_it_out_of_the_conversation(owner, jusi):
    install_id = create_bot(owner).data["id"]
    client_for(owner).delete(f"{BASE}{install_id}/")
    jusi.remove_members.assert_called_once()


def test_removing_a_bot_leaves_a_system_trace(owner, jusi):
    install_id = create_bot(owner).data["id"]
    client_for(owner).delete(f"{BASE}{install_id}/")
    assert "移除了机器人" in jusi.post_message.call_args[1]["body"]


def test_removed_bot_webhook_stops_working(owner, jusi):
    created = create_bot(owner).data
    token = created["webhook_url"].rsplit("/", 1)[-1]
    client_for(owner).delete(f"{BASE}{created['id']}/")
    response = APIClient().post(
        f"/api/bot/v1/hook/{token}",
        {"msg_type": "text", "content": {"text": "hi"}},
        format="json",
    )
    assert response.json()["code"] == 19001


def test_non_owner_cannot_remove(owner, member, jusi):
    install_id = create_bot(owner).data["id"]
    assert client_for(member).delete(f"{BASE}{install_id}/").status_code == 403


# ---- built-in assistants -----------------------------------------------------


@pytest.fixture
def builtin_install():
    bot = models.ImBot.objects.filter(kind=models.ImBotKindChoices.BUILTIN).first()
    assert bot is not None, "migration 0080 should have seeded the assistants"
    return models.ImBotInstallation.objects.create(bot=bot, cid=CID)


def test_builtin_assistants_are_seeded():
    slugs = set(
        models.ImBot.objects.filter(kind=models.ImBotKindChoices.BUILTIN).values_list(
            "slug", flat=True
        )
    )
    assert {"meeting-assistant", "calendar-assistant", "approval-assistant"} <= slugs


def test_builtin_cannot_be_deleted(owner, jusi, builtin_install):
    """Deleting would switch off a product feature with no way back."""
    response = client_for(owner).delete(f"{BASE}{builtin_install.pk}/")
    assert response.status_code == 400
    assert models.ImBotInstallation.objects.filter(pk=builtin_install.pk).exists()


def test_builtin_can_be_silenced_reversibly(owner, jusi, builtin_install):
    response = client_for(owner).patch(
        f"{BASE}{builtin_install.pk}/", {"is_active": False}, format="json"
    )
    assert response.status_code == 200
    assert response.data["is_active"] is False


def test_builtin_cannot_be_renamed(owner, jusi, builtin_install):
    """Its identity is shared by every group; one group must not fork it."""
    original = builtin_install.bot.name
    client_for(owner).patch(f"{BASE}{builtin_install.pk}/", {"name": "我的助手"}, format="json")
    builtin_install.bot.refresh_from_db()
    assert builtin_install.bot.name == original


def test_builtin_has_no_webhook_to_rotate(owner, jusi, builtin_install):
    assert client_for(owner).post(f"{BASE}{builtin_install.pk}/reset-token/").status_code == 400


# ---- avatar upload -----------------------------------------------------------


def test_avatar_upload_url_rejects_a_non_image(owner, jusi):
    response = client_for(owner).post(
        f"{BASE}avatar-upload-url/",
        {"content_type": "application/zip", "size": 100},
        format="json",
    )
    assert response.status_code == 400


def test_avatar_upload_url_rejects_an_oversized_file(owner, jusi):
    response = client_for(owner).post(
        f"{BASE}avatar-upload-url/",
        {"content_type": "image/png", "size": 50 * 1024 * 1024},
        format="json",
    )
    assert response.status_code == 400


def test_avatar_upload_url_is_scoped_to_the_bot_prefix(owner, jusi):
    with mock.patch("core.api.im_bots.utils.generate_bot_avatar_upload_url") as gen:
        gen.return_value = {"upload_url": "https://x", "object_key": "bot/abc.png"}
        response = client_for(owner).post(
            f"{BASE}avatar-upload-url/",
            {"content_type": "image/png", "size": 1024},
            format="json",
        )
    assert response.status_code == 200
    assert response.data["object_key"].startswith("bot/")


# ---- 出站回调的配置(二期 A3)-------------------------------------------------


def _install_for(owner) -> models.ImBotInstallation:
    """建一个自定义机器人并取回它的安装 —— 与既有测试同一条路径。"""
    create_bot(owner)
    return models.ImBotInstallation.objects.filter(cid=CID).latest("created_at")


def test_the_owner_can_set_a_callback_url_and_a_secret_is_minted(owner, jusi):
    install = _install_for(owner)
    """callback_secret 与 signing_secret 是**两把** —— 共用一把的话,任何能看到
    入站密钥的人都能伪造我们的出站调用。所以它是我们自己生成的,群主没填过。"""
    response = client_for(owner).patch(
        f"/api/v1.0/im/bots/{install.pk}/",
        {"callback_url": "https://ci.example.com/hook"},
        format="json",
    )
    assert response.status_code == 200
    install.refresh_from_db()
    assert install.callback_url == "https://ci.example.com/hook"
    assert install.callback_secret
    assert install.callback_secret != install.signing_secret


@pytest.mark.parametrize(
    "url",
    [
        "http://ci.example.com/hook",          # 只允许 https
        "https://169.254.169.254/latest/",     # 元数据(本部署实测可达)
        "https://10.0.0.5/hook",               # 内网
        "https://ci.example.com:22/hook",      # 端口白名单外
        "ftp://ci.example.com/hook",
    ],
)
def test_a_blocked_callback_url_is_rejected_at_write_time(owner, jusi, url):
    install = _install_for(owner)
    """写入时就校验,群主当场看到报错 —— 而不是配完之后每次点击都静默失败。"""
    response = client_for(owner).patch(
        f"/api/v1.0/im/bots/{install.pk}/", {"callback_url": url}, format="json"
    )
    assert response.status_code == 400
    install.refresh_from_db()
    assert install.callback_url == ""


def test_changing_the_url_re_enables_a_self_disabled_callback(owner, jusi):
    install = _install_for(owner)
    """连续失败会自动停用。群主修好地址后必须能自己恢复,不然只能靠猜。"""
    install.callback_url = "https://old.example.com/hook"
    install.callback_enabled = False
    install.callback_failure_count = 20
    install.save()

    client_for(owner).patch(
        f"/api/v1.0/im/bots/{install.pk}/",
        {"callback_url": "https://new.example.com/hook"},
        format="json",
    )
    install.refresh_from_db()
    assert install.callback_enabled is True
    assert install.callback_failure_count == 0


def test_the_callback_secret_is_never_serialized(owner, jusi):
    install = _install_for(owner)
    """与 signing_secret 同档:要看得走单独的凭据接口。"""
    install.callback_url = "https://ci.example.com/hook"
    install.callback_secret = "super-secret-callback-value"
    install.save()
    response = client_for(owner).get(f"/api/v1.0/im/bots/{install.pk}/")
    assert "super-secret-callback-value" not in json.dumps(response.data)


def test_sending_the_clickers_name_is_off_until_the_owner_turns_it_on(owner, jusi):
    install = _install_for(owner)
    """webhook 是群主配的,但点按钮的是每个成员。"""
    assert install.callback_include_identity is False
    client_for(owner).patch(
        f"/api/v1.0/im/bots/{install.pk}/",
        {"callback_include_identity": True},
        format="json",
    )
    install.refresh_from_db()
    assert install.callback_include_identity is True
