"""Compatibility CLI; the shared implementation remains standard-library only."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "backend"))

from core.services.voiceprint_evaluation_report import (  # noqa: E402 -- Locate the backend without Django initialization.
    FEATURE_SPACE as FEATURE_SPACE,
    EvaluationError as EvaluationError,
    cluster_bootstrap as cluster_bootstrap,
    grouped_metric as grouped_metric,
    main as main,
    ratio as ratio,
    summarize as summarize,
)

if __name__ == "__main__":
    raise SystemExit(main())
