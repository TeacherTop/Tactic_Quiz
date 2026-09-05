#!/usr/bin/env python3
"""Download the available OpenTDB question pool into a JSON file."""

from __future__ import annotations

import argparse
import html
import json
import os
import ssl
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://opentdb.com/api.php"
TOKEN_URL = "https://opentdb.com/api_token.php"
DEFAULT_OUTPUT = Path("opentdb_questions.json")
MIN_REQUEST_DELAY = 5.0
MAX_BATCH_SIZE = 50
DEFAULT_ADDITIONAL = 1000
REQUEST_RETRIES = 3


def ssl_context() -> ssl.SSLContext:
	"""Use a trusted certificate store, including the macOS Python fallback."""
	certificate_file = os.environ.get("SSL_CERT_FILE")
	if certificate_file:
		return ssl.create_default_context(cafile=certificate_file)

	system_certificate = Path("/etc/ssl/cert.pem")
	if system_certificate.exists():
		return ssl.create_default_context(cafile=str(system_certificate))
	return ssl.create_default_context()


def request_json(url: str, params: dict[str, str] | None = None) -> dict[str, Any]:
	"""Make an OpenTDB request and return its JSON response."""
	query = f"?{urlencode(params)}" if params else ""
	request = Request(
		f"{url}{query}",
		headers={"User-Agent": "Tactic-Quiz-OpenTDB-Exporter/1.0"},
	)
	for attempt in range(REQUEST_RETRIES):
		try:
			with urlopen(request, timeout=30, context=ssl_context()) as response:
				return json.loads(response.read().decode("utf-8"))
		except HTTPError as error:
			raise RuntimeError(f"OpenTDB HTTP error {error.code}: {error.reason}") from error
		except (TimeoutError, URLError) as error:
			if attempt == REQUEST_RETRIES - 1:
				reason = getattr(error, "reason", error)
				raise RuntimeError(f"Could not reach OpenTDB after {REQUEST_RETRIES} attempts: {reason}") from error
			wait_seconds = 3 * (attempt + 1)
			print(f"Network error, retrying in {wait_seconds}s ({attempt + 1}/{REQUEST_RETRIES - 1})...")
			time.sleep(wait_seconds)

	raise RuntimeError("OpenTDB request failed")


def request_token() -> str:
	response = request_json(TOKEN_URL, {"command": "request"})
	if response.get("response_code") != 0 or not response.get("token"):
		raise RuntimeError(f"Could not create OpenTDB session token: {response}")
	return str(response["token"])


def reset_token(token: str) -> None:
	response = request_json(TOKEN_URL, {"command": "reset", "token": token})
	if response.get("response_code") != 0:
		raise RuntimeError(f"Could not reset OpenTDB session token: {response}")


def clean_question(raw: dict[str, Any]) -> dict[str, Any]:
	"""Decode OpenTDB HTML entities and normalize answer fields."""
	correct = html.unescape(str(raw["correct_answer"]))
	incorrect = [html.unescape(str(answer)) for answer in raw["incorrect_answers"]]
	answers = [correct, *incorrect]
	return {
		"category": html.unescape(str(raw["category"])),
		"difficulty": raw["difficulty"],
		"type": raw["type"],
		"question": html.unescape(str(raw["question"])),
		"correct_answer": correct,
		"incorrect_answers": incorrect,
		"answers": answers,
	}


def question_key(question: dict[str, Any]) -> tuple[str, str]:
	return str(question["question"]), str(question["correct_answer"])


def load_questions(output: Path) -> dict[tuple[str, str], dict[str, Any]]:
	if not output.exists():
		return {}
	try:
		data = json.loads(output.read_text(encoding="utf-8"))
	except json.JSONDecodeError as error:
		raise RuntimeError(f"Existing JSON is invalid: {output}: {error}") from error
	if not isinstance(data, list):
		raise RuntimeError(f"Existing JSON must contain an array: {output}")
	return {
		question_key(question): question
		for question in data
		if isinstance(question, dict) and "question" in question and "correct_answer" in question
	}


def download_questions(
	*,
	output: Path,
	batch_size: int,
	delay: float,
	max_batches: int | None,
	additional: int,
	category: str | None,
	difficulty: str | None,
	question_type: str | None,
) -> int:
	token = request_token()
	questions = load_questions(output)
	initial_count = len(questions)
	added = 0
	batches = 0
	print(f"Existing questions: {initial_count}. Downloading up to {additional} more.")

	try:
		while added < additional and (max_batches is None or batches < max_batches):
			requested_amount = min(batch_size, additional - added)
			params = {
				"amount": str(requested_amount),
				"token": token,
			}
			if category:
				params["category"] = category
			if difficulty:
				params["difficulty"] = difficulty
			if question_type:
				params["type"] = question_type

			response = request_json(API_URL, params)
			response_code = response.get("response_code")
			if response_code == 1:
				break
			if response_code == 4:
				reset_token(token)
				continue
			if response_code != 0:
				raise RuntimeError(f"OpenTDB returned response_code={response_code}")

			batch = [clean_question(item) for item in response.get("results", [])]
			if not batch:
				break
			before = len(questions)
			questions.update((question_key(item), item) for item in batch)
			added = len(questions) - initial_count
			batches += 1
			print(f"Batch {batches}: +{len(questions) - before}, added {added}, total {len(questions)}")

			if len(batch) < requested_amount:
				break
			time.sleep(max(delay, MIN_REQUEST_DELAY))
	finally:
		output.write_text(
			json.dumps(list(questions.values()), ensure_ascii=False, indent=2),
			encoding="utf-8",
		)

	return len(questions)


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT)
	parser.add_argument("--batch-size", type=int, default=MAX_BATCH_SIZE, choices=range(1, MAX_BATCH_SIZE + 1))
	parser.add_argument("--delay", type=float, default=MIN_REQUEST_DELAY, help="Seconds between API requests, minimum 5")
	parser.add_argument("--max-batches", type=int, help="Stop after this many batches; useful for testing")
	parser.add_argument("--additional", "--limit", dest="additional", type=int, default=DEFAULT_ADDITIONAL, help=f"Number of new unique questions to add (default: {DEFAULT_ADDITIONAL})")
	parser.add_argument("--category", help="OpenTDB category id")
	parser.add_argument("--difficulty", choices=("easy", "medium", "hard"))
	parser.add_argument("--type", dest="question_type", choices=("multiple", "boolean"))
	return parser.parse_args()


def main() -> None:
	args = parse_args()
	try:
		total = download_questions(
			output=args.output,
			batch_size=args.batch_size,
			delay=args.delay,
			max_batches=args.max_batches,
			additional=args.additional,
			category=args.category,
			difficulty=args.difficulty,
			question_type=args.question_type,
		)
	except KeyboardInterrupt:
		print("\nStopped by user. Downloaded questions were saved; run the script again to continue.")
		return
	print(f"Saved {total} questions to {args.output}")


if __name__ == "__main__":
	main()
