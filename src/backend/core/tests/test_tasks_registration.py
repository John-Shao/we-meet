"""Every task module must be imported by ``core.tasks.__init__``.

Celery's ``autodiscover_tasks()`` imports ``core.tasks`` and stops there — when
``tasks`` is a package, its sub-modules are not walked. A module missing from
that ``__init__`` is therefore never registered on the worker, and a
``.delay()`` against it is accepted by the broker and then dropped by the
worker as ``NotRegistered``.

The reason this needs a test rather than care: **it cannot fail locally.** With
``CELERY_ENABLED=False`` the decorator in ``core/tasks/_task.py`` returns the
plain function with an inline ``.delay()``, so an unregistered module behaves
perfectly in development and in the whole test suite. The first evidence is a
production job that sits at "pending" and a log line nobody is reading.
"""

import importlib
import pkgutil

import core.tasks


def test_every_task_module_is_imported_by_the_package():
    on_disk = {
        name
        for _finder, name, _ispkg in pkgutil.iter_modules(core.tasks.__path__)
        if not name.startswith("_")
    }
    imported = {
        module.__name__.rpartition(".")[2]
        for module in vars(core.tasks).values()
        if getattr(module, "__name__", "").startswith("core.tasks.")
    }

    missing = on_disk - imported
    assert not missing, (
        f"core/tasks/__init__.py does not import: {sorted(missing)}. "
        "Celery will not register those tasks and .delay() will silently drop."
    )


def test_the_new_p10_tasks_are_reachable_by_name():
    """Names the worker resolves at dispatch time, spelled out once."""
    for path in ("core.tasks.activity", "core.tasks.member_import"):
        assert importlib.import_module(path) is not None
