from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("core", "0086_im_input_sync_and_custom_emojis")]

    operations = [migrations.DeleteModel(name="ImDraft")]
