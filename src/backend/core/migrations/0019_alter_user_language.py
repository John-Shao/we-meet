# Generated for adding zh-hans (Simplified Chinese) to LANGUAGES and changing default to zh-hans
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0018_rename_active_application_is_active'),
    ]

    operations = [
        migrations.AlterField(
            model_name='user',
            name='language',
            field=models.CharField(
                choices=settings.LANGUAGES,
                default=settings.LANGUAGE_CODE,
                help_text='The language in which the user wants to see the interface.',
                max_length=10,
                verbose_name='language',
            ),
        ),
    ]
