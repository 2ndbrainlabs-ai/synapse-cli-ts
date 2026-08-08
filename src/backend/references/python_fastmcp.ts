// src/backend/references/python_fastmcp.ts
//
// Reference Python FastMCP server used as in-context example for tool-shaper.
// Ported from the private Python backend's references/python_fastmcp.py.

export const PYTHON_FASTMCP_REFERENCE = `"""Reference: Python FastMCP server with 2 example tools.

This is NOT executed — it's used as a reference example for LLM-based generation.
The LLM receives this as context to understand the correct pattern.
"""

import os
import logging
from typing import Optional
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

server = FastMCP("example-server")


@server.tool()
async def get_user_by_id(user_id: str) -> dict:
    """Retrieve a user record by their unique identifier."""
    from app.models.user import get_user_by_id
    result = get_user_by_id(user_id=user_id)
    return result


@server.tool()
async def send_notification(recipient: str, message: str, priority: Optional[str] = None) -> dict:
    """Send a notification to a recipient with optional priority level."""
    from app.services.notifications import send_notification
    api_key = os.getenv("NOTIFICATION_API_KEY")
    result = send_notification(api_key=api_key, recipient=recipient, message=message, priority=priority)
    return result


if __name__ == "__main__":
    server.run()
`;
