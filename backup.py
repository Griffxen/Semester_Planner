"""Consistent SQLite backup; restoration requires stopping the app first."""
import argparse,datetime,sqlite3
from pathlib import Path
from app import DB
p=argparse.ArgumentParser();p.add_argument('--output',default='backups');a=p.parse_args()
if not DB.exists():raise SystemExit('Database does not exist')
out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
target=out/('planner-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.db')
with sqlite3.connect(DB) as src,sqlite3.connect(target) as dst:src.backup(dst)
target.chmod(0o600)
print(target)
