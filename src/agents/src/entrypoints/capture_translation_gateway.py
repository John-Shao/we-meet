"""Start the capture translation gateway worker."""

import asyncio

from translation.capture_gateway import main

if __name__ == "__main__":
    asyncio.run(main())
