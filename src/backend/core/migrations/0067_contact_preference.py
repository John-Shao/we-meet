"""星标与「特别提醒」解耦(对标企业微信)。

0066 是飞书式的耦合实现:``StarredContact`` 一行既表示归类、又驱动推送穿透,穿透
再被一个全局开关 ``PushPreference.starred_bypass_quiet`` 兜一层。问题是打星标本
来只是「我想快点找到这个人」,却顺带改了半夜手机响不响 —— 隐式副作用。

这里把它拆成同一行上两个**互不影响**的 flag:``is_starred`` 只管归类,
``special_alert`` 只管通知。全局开关随之删除(逐联系人已经是显式意图)。

数据处理:0066 的既有行都是「打了星标」的,所以 ``is_starred`` 回填 True;
``special_alert`` 保持默认 False —— 老行为里星标默认穿透静默时段,但那正是本次
要去掉的隐式副作用,不能自动替用户开启一个通知类开关。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0066_starred_contacts"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="StarredContact",
            new_name="ContactPreference",
        ),
        migrations.AlterModelTable(
            name="contactpreference",
            table="meet_contact_preference",
        ),
        migrations.AlterModelOptions(
            name="contactpreference",
            options={
                "ordering": ("created_at",),
                "verbose_name": "contact preference",
                "verbose_name_plural": "contact preferences",
            },
        ),
        # RenameModel carries the old constraint/index names over — rename them
        # too so the schema matches the model's Meta (otherwise makemigrations
        # keeps proposing a diff forever).
        migrations.RemoveConstraint(
            model_name="contactpreference",
            name="one_star_per_owner_target",
        ),
        migrations.RemoveIndex(
            model_name="contactpreference",
            name="starred_target_owner_idx",
        ),
        migrations.AlterField(
            model_name="contactpreference",
            name="owner",
            field=models.ForeignKey(
                on_delete=models.deletion.CASCADE,
                related_name="contact_preferences",
                to="core.user",
            ),
        ),
        migrations.AlterField(
            model_name="contactpreference",
            name="target",
            field=models.ForeignKey(
                on_delete=models.deletion.CASCADE,
                related_name="contact_preferred_by",
                to="core.user",
            ),
        ),
        migrations.AddField(
            model_name="contactpreference",
            name="is_starred",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Filing only: listed under 星标联系人 and marked ⭐ in the "
                    "conversation list. Does not affect notifications."
                ),
                verbose_name="starred",
            ),
        ),
        migrations.AddField(
            model_name="contactpreference",
            name="special_alert",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Their messages push through the owner's quiet hours and "
                    "are marked in the conversation list. Independent of "
                    "is_starred."
                ),
                verbose_name="special alert",
            ),
        ),
        # 既有行都来自「设为星标联系人」,回填 is_starred=True。
        migrations.RunSQL(
            sql="UPDATE meet_contact_preference SET is_starred = true;",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddConstraint(
            model_name="contactpreference",
            constraint=models.UniqueConstraint(
                fields=("owner", "target"),
                name="one_contact_pref_per_owner_target",
            ),
        ),
        migrations.AddIndex(
            model_name="contactpreference",
            index=models.Index(
                fields=["target", "owner"], name="contactpref_target_owner_idx"
            ),
        ),
        migrations.RemoveField(
            model_name="pushpreference",
            name="starred_bypass_quiet",
        ),
    ]
