import ast
import contextlib
import io
import json
import sys
import traceback

MAX_OUTPUT_BYTES = 64 * 1024
TRUNCATED = "\n... (truncated)"

def bounded(text):
    encoded = text.encode("utf-8")
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return text
    limit = MAX_OUTPUT_BYTES - len(TRUNCATED.encode("utf-8"))
    return encoded[:limit].decode("utf-8", "ignore") + TRUNCATED

scope = {"__name__": "__medpi_kernel__"}

def execute(code):
    stdout, stderr = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            tree = ast.parse(code, mode="exec")
            value = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                prefix = ast.Module(body=tree.body[:-1], type_ignores=[])
                exec(compile(prefix, "<medpi-cell>", "exec"), scope)
                value = eval(compile(ast.Expression(tree.body[-1].value), "<medpi-cell>", "eval"), scope)
            else:
                exec(compile(tree, "<medpi-cell>", "exec"), scope)
        return {"status": "ok", "stdout": bounded(stdout.getvalue()), "stderr": bounded(stderr.getvalue()), "value": bounded(repr(value) if value is not None else "")}
    except Exception:
        return {"status": "error", "stdout": bounded(stdout.getvalue()), "stderr": bounded(stderr.getvalue() + traceback.format_exc()), "value": ""}

while True:
    header = sys.stdin.buffer.readline()
    if not header:
        break
    try:
        size = int(header.strip())
        if size < 0 or size > 65536:
            raise ValueError("invalid cell size")
        data = sys.stdin.buffer.read(size)
        if len(data) != size:
            raise ValueError("incomplete cell")
        result = execute(data.decode("utf-8"))
    except Exception:
        result = {"status": "error", "stdout": "", "stderr": bounded(traceback.format_exc()), "value": ""}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()
