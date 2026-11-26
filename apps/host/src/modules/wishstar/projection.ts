type Obj = Record<string, any>;
const pick = (value: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value : [];
const request = (v: Obj): Obj => pick(v,['id','requester_id','owner_id','status','requested_at','responded_at','opened_at','opened_star_id']);
const offer = (v: Obj): Obj => pick(v,['id','star_id','sender_id','recipient_id','status','message','offered_at','opened_at']);
function star(v: Obj): Obj {
  const out = pick(v,['id','content','visibility','state','author_id','author_name','written_at','created_at','mood_type','mood_text','note',
    'opened_at','opened_by','opened_by_name','open_mode','shared_origin','source_label','cycle_id','shared_at',
    'being_offered','waiting_random_delivery','in_active_session','new_response_ids']);
  if (Array.isArray(v.responses)) out.responses = v.responses.map((r: Obj) => pick(r,['id','responder_id','responder_name','type','text','content','created_at']));
  if (Array.isArray(v.views)) out.views = v.views.map((r: Obj) => pick(r,['viewer_id','viewer_name','view_count','first_view_at','last_view_at']));
  return out;
}

export function projectWishstarToolResult(name: string, v: Obj): Obj {
  switch (name) {
    case 'wishstar_hidden_stars': return {items:rows(v.items).map(star)};
    case 'wishstar_shared_stars': return {items:rows(v.items).map(star)};
    case 'wishstar_special_dates': return {items:rows(v.items).map(d=>pick(d,['id','name','month','day','year','type','active']))};
    case 'wishstar_list_offers': return {incoming:rows(v.incoming).map(offer),outgoing:rows(v.outgoing).map(offer)};
    case 'wishstar_notifications': return {...pick(v,['unread_count','consumed']),items:rows(v.items).map(n=>pick(n,['id','type','title','body','star_id','created_at','is_read']))};
    case 'wishstar_write_star': return pick(v,['id','star_id','visibility','state']);
    case 'wishstar_reply_star': return pick(v,['id','star_id','type','created_at']);
    case 'wishstar_offer_star': return offer(v);
    case 'wishstar_request_star': return request(v);
    case 'wishstar_requests': return {incoming:rows(v.incoming).map(request),outgoing:rows(v.outgoing).map(request)};
    case 'wishstar_respond_request': return {...(v.request ? {request:request(v.request)} : {}),...pick(v,['note'])};
    case 'wishstar_take_star': case 'wishstar_accept_offer': return star(v);
    case 'wishstar_start_session': case 'wishstar_confirm_session': case 'wishstar_finish_session':
      return pick(v,['id','session_id','type','special_date_id','status','initiated_by','confirmed_by','actor_a_count','actor_b_count','quota_cutoff_at','started_at','ended_at']);
    default: throw Error(`WISHSTAR_PROJECTION_MISSING:${name}`);
  }
}
