"""Read the existing domain source into generated limits and synthetic DTOs.

Uses an explicit temporary SQLite database; never imports the running app or
changes the sibling checkout. Same explicit vendor workflow as oído/Mariposa.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
repo = args.repo.resolve()
sys.path.insert(0, str(repo))
with tempfile.TemporaryDirectory(prefix='wishstar-contract-') as temp:
    os.environ['SUPERPOSITION_DB_PATH'] = str(Path(temp)/'synthetic.sqlite3')
    from app import config
    from app.common import business_now
    from app.db.connection import Database
    from app.db.schema import DDL, MIGRATIONS
    from app.repositories import user_repo
    from app.services.star_service import StarService
    from app.domain.errors import InvalidStateError, PermissionDeniedError, ValidationError
    files = ['app/config.py','app/api/routes.py','app/services/star_service.py']
    contract = {
        'source_commit': subprocess.check_output(['git','log','-1','--format=%H','--',*files],cwd=repo,text=True).strip(),
        'source_files': {file:hashlib.sha256((repo/file).read_bytes()).hexdigest() for file in files},
        'limits': {'content':config.MAX_CONTENT_LENGTH,'mood':config.MAX_MOOD_LENGTH,
                   'note':config.MAX_NOTE_LENGTH,'message':config.MAX_OFFER_MESSAGE_LENGTH},
    }
    target = root/'apps/host/src/integrations/wishstar/contracts/public-fields.json'
    text = json.dumps(contract,ensure_ascii=False,indent=2)+'\n'
    if args.check:
        if not target.exists() or target.read_text()!=text: raise SystemExit('Wishstar contract is stale')
        raise SystemExit(0)
    target.parent.mkdir(parents=True,exist_ok=True); target.write_text(text)
    def service(name):
        db = Database(Path(temp)/(name+'.sqlite3'),MIGRATIONS)
        def seed(conn):
            for actor, partner in (("jiaming","qiaosheng"),("qiaosheng","jiaming")):
                user_repo.insert(conn,{"id":actor,"name":"SYNTHETIC_"+actor,"partner_id":partner,"created_at":"2026-11-01T00:00:00"})
        db.init(DDL,seed)
        return StarService(db)
    svc = service('offers')
    created = svc.create_star('jiaming','SYNTHETIC_MY_STAR AbC  原生空格。','hidden')
    outgoing = svc.offer_hidden_star('jiaming',created['id'],message='SYNTHETIC_OFFER')
    partner = svc.create_star('qiaosheng','SYNTHETIC_ACCEPT_BODY AbC\n第二行','hidden')
    incoming = svc.offer_hidden_star('qiaosheng',partner['id'])
    offers = svc.list_offers('jiaming')
    try:
        svc.accept_offered_star('qiaosheng',incoming['id'])
        raise AssertionError('wrong recipient accepted')
    except PermissionDeniedError:
        pass
    accepted = svc.accept_offered_star('jiaming',incoming['id'])
    try:
        svc.accept_offered_star('jiaming',incoming['id'])
        raise AssertionError('same offer accepted twice')
    except InvalidStateError:
        pass
    svc.create_star('jiaming','SYNTHETIC_PRIVATE_REMAINING','hidden')
    try:
        svc.create_star('jiaming','x' * (config.MAX_CONTENT_LENGTH + 1),'hidden')
        raise AssertionError('overlong content accepted')
    except ValidationError:
        pass
    requests = service('requests')
    requests.create_star('jiaming','SYNTHETIC_REQUEST_STAR','hidden')
    request = requests.request_hidden_star('qiaosheng')
    pending_requests = requests.list_requests('jiaming')
    response = requests.respond_hidden_request('jiaming',request['id'],'give')
    ritual = service('ritual')
    today = business_now().date()
    special = ritual.add_special_date('qiaosheng','合成特殊日',today.month,today.day)
    ritual.create_star('jiaming','SYNTHETIC_SELF_QUOTA','hidden')
    ritual.create_star('qiaosheng','SYNTHETIC_TAKE_BODY AbC  原生空格。','hidden')
    session = ritual.start_special_session('jiaming',special_date_id=special['id'])
    confirmed = ritual.confirm_special_session('qiaosheng',session['id'])
    taken = ritual.take_next_session_star('jiaming',session['id'],operation_id='synthetic-take')
    try:
        ritual.take_next_session_star('jiaming',session['id'],operation_id='synthetic-second-take')
        raise AssertionError('next star opened before response')
    except InvalidStateError:
        pass
    finished = ritual.finish_special_session('jiaming',session['id'])
    fixture = {'source':contract,'verified_rejections':['wrong_recipient','duplicate_accept','content_limit','unresponded_star'],'responses':{
        'wishstar_write_star':created,'wishstar_hidden_stars':svc.list_my_hidden_stars('jiaming'),
        'wishstar_special_dates':ritual.list_special_dates('jiaming'),'wishstar_list_offers':offers,
        'wishstar_notifications':svc.list_notifications('jiaming'),'wishstar_requests':pending_requests,'wishstar_offer_star':outgoing,
        'wishstar_accept_offer':accepted,'wishstar_request_star':request,'wishstar_respond_request':response,
        'wishstar_start_session':session,'wishstar_confirm_session':confirmed,
        'wishstar_take_star':taken,'wishstar_finish_session':finished,
    }}
    (root/'tests/fixtures/wishstar-domain-responses.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2)+'\n')
