"""Start the capture translation gateway worker."""

import asyncio
import logging

from translation.capture_gateway import main

if __name__ == "__main__":
    # Keep provider libraries quiet; application diagnostics never contain PCM,
    # transcripts, tokens or provider payloads.
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    for name in (
        "assistant-translation",
        "bilingual-audio",
        "bilingual-router",
        "bilingual-session",
        "omni-language-id",
    ):
        logging.getLogger(name).setLevel(logging.INFO)
    asyncio.run(main())
