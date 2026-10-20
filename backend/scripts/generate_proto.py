"""Create the Python gRPC modules from proto/payment.proto."""

import subprocess
import sys
from pathlib import Path


def proto_path() -> Path:
    backend_dir = Path(__file__).resolve().parents[1]
    candidates = [
        backend_dir.parent / "proto" / "payment.proto",
        Path("/proto/payment.proto"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SystemExit("Could not find proto/payment.proto.")


def main() -> None:
    proto = proto_path()
    output_dir = Path(__file__).resolve().parents[1] / "generated"
    output_dir.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"-I{proto.parent}",
            f"--python_out={output_dir}",
            f"--grpc_python_out={output_dir}",
            str(proto),
        ]
    )
    grpc_file = output_dir / "payment_pb2_grpc.py"
    text = grpc_file.read_text(encoding="utf-8").replace("\r\n", "\n")
    replacement = "from generated import payment_pb2 as payment__pb2"
    needle = "import payment_pb2 as payment__pb2"
    if replacement not in text:
        if needle not in text:
            raise SystemExit("Generated gRPC import did not match the expected pattern.")
        text = text.replace(needle, replacement)
    grpc_file.write_text(text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
