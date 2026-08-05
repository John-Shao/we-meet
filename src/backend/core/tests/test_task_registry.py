"""``core/tasks`` 的每个模块都必须在 ``__init__.py`` 里被 import。

Celery 的 ``autodiscover_tasks()`` 找的是 ``<app>.tasks``;当 ``tasks`` 是一个
**包**(本仓就是)时,子模块**不会**被自动 import。漏一个的后果非常刁钻:

* 本地全绿 —— ``CELERY_ENABLED=False`` 时 ``_task.py`` 的装饰器交回一个普通
  函数,``.delay()`` 就地同步执行
* 测试也全绿 —— 同上
* **只在生产表现为「任务永远 pending」**,没有异常、没有日志

也就是说这条规则不可能被任何别的测试兜住。它必须有自己这一条。
"""

import ast
import pathlib

TASKS_DIR = pathlib.Path(__file__).resolve().parent.parent / "tasks"


def _module_names() -> set[str]:
    return {
        p.stem
        for p in TASKS_DIR.glob("*.py")
        if p.stem != "__init__" and not p.stem.startswith("_")
    }


def _imported_names() -> set[str]:
    tree = ast.parse((TASKS_DIR / "__init__.py").read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").endswith("core.tasks"):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            names.update(alias.name.rsplit(".", 1)[-1] for alias in node.names)
    return names


def test_every_task_module_is_registered():
    missing = _module_names() - _imported_names()
    assert not missing, (
        f"{sorted(missing)} 在 core/tasks/ 里但没有出现在 __init__.py 的 import 中。"
        "本地和测试都不会因此失败 —— 只有生产会,表现为任务永远 pending。"
        "在**同一个 commit** 里补上 import。"
    )


def test_the_guard_itself_is_not_vacuous():
    """目录空了或解析挂了会让上面那条永远绿。"""
    assert len(_module_names()) >= 5
    assert "bot_callback" in _module_names()
