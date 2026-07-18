# Hand-written for P2-M1 重复日程 (docs/features/foundation_p0_p3.md §P2-D1).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0057_pushpreference'),
    ]

    operations = [
        migrations.AddField(
            model_name='calendarevent',
            name='recurrence_exdates',
            field=models.JSONField(blank=True, default=list, verbose_name='recurrence exdates'),
        ),
        migrations.AddConstraint(
            model_name='calendarevent',
            constraint=models.UniqueConstraint(
                condition=models.Q(('recurrence_parent__isnull', False)),
                fields=('recurrence_parent', 'start_at'),
                name='calevent_parent_start_uniq',
            ),
        ),
    ]
