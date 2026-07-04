"""诊断 IM 身份错位:同一个人是否有多条 we-meet User 行(不同 im_uid),
导致「A 解析 B」时命中一条 avatar_key 为空 / 组织不含 B 的旧行。

典型症状:对端在 Web 显示名字正常但头像退成色块(resolve 返回空 avatar_url),
或直聊标题退成「会话」(跨组织解析不到)。参见 im/users/resolve 的 org-scope。

用法:
    # 按 im_uid(可多个;从 jusi 会话成员里取到的 uid 直接喂进来)
    python manage.py im_identity_probe <im_uid> [<im_uid> ...]
    # 按名字/邮箱子串(找出「同一个人」的所有 User 行,看是否重复)
    python manage.py im_identity_probe --search 3796

只读,不写库。
"""

from django.core.management.base import BaseCommand

from core import models


def _rows_for(qs):
    out = []
    for u in qs:
        memberships = [
            f"{m.organization_id}:{m.status}"
            for m in u.memberships.all()
        ]
        out.append(
            {
                "id": str(u.id),
                "sub": u.sub,
                "email": u.email or "",
                "full_name": (u.full_name or u.short_name or "").strip(),
                "im_uid": u.im_uid or "",
                "avatar_key": u.avatar_key or "",
                "is_device": u.is_device,
                "memberships": memberships,
            }
        )
    return out


class Command(BaseCommand):
    help = "诊断 IM 身份错位:列出匹配的 User 行(id/sub/im_uid/avatar_key/组织),标记重复身份。"

    def add_arguments(self, parser):
        parser.add_argument("im_uids", nargs="*", help="要排查的 im_uid(可多个)")
        parser.add_argument(
            "--search",
            dest="search",
            default="",
            help="按 full_name / email 子串搜(找同一个人的所有 User 行)",
        )

    def handle(self, *args, **options):
        im_uids = options["im_uids"]
        search = options["search"].strip()

        if not im_uids and not search:
            self.stderr.write("需要传 im_uid 或 --search;见 --help")
            return

        qs = models.User.objects.all().prefetch_related("memberships")
        seen_ids = set()
        rows = []

        if im_uids:
            for r in _rows_for(qs.filter(im_uid__in=im_uids)):
                if r["id"] not in seen_ids:
                    seen_ids.add(r["id"])
                    rows.append(r)
            # 提示:传入但查无对应 User 的 im_uid(会话引用了已不存在的旧身份)。
            found_uids = {r["im_uid"] for r in rows}
            for uid in im_uids:
                if uid not in found_uids:
                    self.stdout.write(
                        self.style.WARNING(f"[!] im_uid={uid} 无对应 User 行(悬空引用)")
                    )

        if search:
            from django.db.models import Q

            match = qs.filter(
                Q(full_name__icontains=search)
                | Q(short_name__icontains=search)
                | Q(email__icontains=search)
            )
            for r in _rows_for(match):
                if r["id"] not in seen_ids:
                    seen_ids.add(r["id"])
                    rows.append(r)

        if not rows:
            self.stdout.write("无匹配 User 行。")
            return

        for r in rows:
            has_av = "有头像" if r["avatar_key"] else "空头像"
            dev = " [device]" if r["is_device"] else ""
            self.stdout.write(
                self.style.SUCCESS(f"— {r['full_name'] or '(无名)'}{dev}")
            )
            self.stdout.write(f"    user_id   : {r['id']}")
            self.stdout.write(f"    sub       : {r['sub']}")
            self.stdout.write(f"    email     : {r['email']}")
            self.stdout.write(f"    im_uid    : {r['im_uid']}")
            self.stdout.write(f"    avatar    : {has_av}  ({r['avatar_key']})")
            self.stdout.write(
                f"    org会员   : {', '.join(r['memberships']) or '(无)'}"
            )

        # 重复身份检测:同一 sub 或同一(非空)email 落在多条 User 行上。
        by_sub = {}
        by_email = {}
        for r in rows:
            by_sub.setdefault(r["sub"], []).append(r)
            if r["email"]:
                by_email.setdefault(r["email"].lower(), []).append(r)

        dupes = [g for g in by_sub.values() if len(g) > 1]
        dupes += [g for g in by_email.values() if len(g) > 1]
        if dupes:
            self.stdout.write("")
            self.stdout.write(
                self.style.ERROR("⚠ 检测到疑似重复身份(同一个人多条 User 行):")
            )
            for g in dupes:
                ids = ", ".join(
                    f"{x['im_uid'] or '(无im_uid)'}→{'有头像' if x['avatar_key'] else '空头像'}"
                    for x in g
                )
                self.stdout.write(f"    {g[0]['full_name'] or g[0]['sub']}: {ids}")
            self.stdout.write(
                "    修复:会话应引用「有头像/活跃组织」那条的 im_uid;"
                "或合并重复 User(把旧行的 im_uid/avatar_key 归并到主行)。"
            )
        else:
            self.stdout.write("")
            self.stdout.write("未发现重复身份(按 sub/email)。")
