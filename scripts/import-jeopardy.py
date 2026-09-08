"""Build the server-only Jeopardy bank; preserve the original tab-separated export."""
import csv
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
rows = []
seen = set()
with (root / 'Russian_QA_Jeopardy_dataset_extended.csv').open(encoding='utf-8-sig', newline='') as source:
    for row in csv.DictReader(source, delimiter='\t'):
        question, answer, topic = (row[key].strip() for key in ('QuestionText', 'Answer', 'Topic'))
        if not question or not answer or answer in ('None', 'nan'):
            continue
        ident = 'j-' + row['QuestionID']
        if ident in seen:
            raise ValueError('Duplicate question ID: ' + ident)
        seen.add(ident)
        rows.append(dict(id=ident, question=question, answer=answer, topic=topic or 'Общие знания'))
output = root / 'server/data/jeopardy.json'
output.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'{len(rows)} questions; {output.stat().st_size:,} bytes')
