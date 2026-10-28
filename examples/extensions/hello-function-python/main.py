# SPDX-License-Identifier: GPL-2.0-or-later
def handler(inputs: dict) -> dict:
    return {"result": f"Hello, {inputs.get('name', 'world')}!"}
