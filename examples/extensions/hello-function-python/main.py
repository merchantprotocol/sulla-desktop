def handler(inputs: dict) -> dict:
    return {"result": f"Hello, {inputs.get('name', 'world')}!"}
