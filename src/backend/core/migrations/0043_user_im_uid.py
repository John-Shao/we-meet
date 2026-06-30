from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0042_bootstrap_default_organization"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="im_uid",
            field=models.CharField(
                blank=True,
                editable=False,
                help_text=(
                    "Cached jusi-light-im internal uid, backfilled on first IM token "
                    "issue. Lets the IM bridge resolve conversation members (uids) → "
                    "display names."
                ),
                max_length=36,
                null=True,
                unique=True,
                verbose_name="IM uid",
            ),
        ),
    ]
