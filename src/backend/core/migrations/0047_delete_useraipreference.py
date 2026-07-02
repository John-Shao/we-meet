# Drop UserAIPreference: cross-device sync of last-used AI config was never
# consumed by any client, so the cloud-side preference is removed entirely.

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0046_approval'),
    ]

    operations = [
        migrations.DeleteModel(
            name='UserAIPreference',
        ),
    ]
