from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0235_work_directory_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="auth_epoch",
            field=models.PositiveBigIntegerField(
                default=0,
                help_text=(
                    "Monotonic per-user counter for the Work Bearer plane; advanced "
                    "on login/logout to invalidate desktop device sessions and proofs."
                ),
                verbose_name="Work auth epoch",
            ),
        ),
    ]