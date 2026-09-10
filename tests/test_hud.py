import asyncio
import json
import pytest
import httpx
from providers import hud
from providers.base import TTLCache


@pytest.fixture(autouse=True)
def isolated_hud(monkeypatch):
    monkeypatch.setenv('HUD_API_TOKEN', 'test-secret-not-for-output')
    monkeypatch.setattr(hud, '_cache', TTLCache(86400))
    monkeypatch.setattr(hud, '_geo_cache', TTLCache(86400))
    monkeypatch.setattr(hud, '_locks', {})


def table():
    return {'year': '2027', 'area_name': 'Stockton-Lodi, CA MSA', 'basicdata': [
        {'zip_code':'MSA level','Efficiency':1525,'Three-Bedroom':2790,'Four-Bedroom':3368},
        {'zip_code':'95336','Efficiency':1640,'Three-Bedroom':2990,'Four-Bedroom':3610},
        {'zip_code':'95337','Efficiency':1860,'Three-Bedroom':3410,'Four-Bedroom':4110},
    ]}


def test_hud_prefers_exact_zip_and_never_substitutes_neighbor_zip():
    result=hud.normalize(table(), '95336', 3, 2027)
    assert result['gross_rent']==2990
    assert result['geography_level']=='zip'
    assert result['source']=='hud_safmr'
    result=hud.normalize(table(), '99999', 3, 2027)
    assert result['gross_rent']==2790
    assert result['geography_level']=='area'
    assert result['zip'] is None


def test_hud_standard_fmr_studio_and_derived_large_bedrooms():
    data={'county_name':'Test County','basicdata':{'year':'2026','Efficiency':'1000','Four-Bedroom':'2000'}}
    assert hud.normalize(data,None,0,2026)['gross_rent']==1000
    result=hud.normalize(data,None,6,2026)
    assert result['gross_rent']==2600
    assert result['derived_bedrooms'] is True
    assert result['source']=='hud_fmr'


def test_hud_rejects_wrong_year_and_missing_zip_without_area():
    with pytest.raises(hud.HUDError,match='different fiscal year'):
        hud.normalize(table(),'95336',3,2026)
    data=table();data['basicdata']=data['basicdata'][1:]
    with pytest.raises(hud.HUDError,match='No matching ZIP'):
        hud.normalize(data,'99999',3,2027)


def test_hud_auth_only_sent_to_hud_and_requests_are_cached(monkeypatch):
    calls=[]
    def handler(request):
        assert request.url.host=='www.huduser.gov'
        assert request.headers['Authorization']=='Bearer test-secret-not-for-output'
        assert request.url.params['year']=='2027'
        calls.append(request)
        return httpx.Response(200,json={'data':table()})
    client=httpx.AsyncClient
    monkeypatch.setattr(hud.httpx,'AsyncClient',lambda **kwargs:client(transport=httpx.MockTransport(handler),**kwargs))
    async def run():
        a=await hud.benchmark('',3,2027,'0607799999','95336')
        b=await hud.benchmark('',3,2027,'0607799999','95337')
        return a,b
    a,b=asyncio.run(run())
    assert len(calls)==1
    assert a['gross_rent']==2990 and b['gross_rent']==3410


def test_hud_errors_never_include_upstream_response_or_token(monkeypatch):
    def handler(request):
        return httpx.Response(403,text='test-secret-not-for-output')
    client=httpx.AsyncClient
    monkeypatch.setattr(hud.httpx,'AsyncClient',lambda **kwargs:client(transport=httpx.MockTransport(handler),**kwargs))
    with pytest.raises(hud.HUDError) as exc:
        asyncio.run(hud.benchmark('',3,2027,'0607799999','95336'))
    assert 'test-secret' not in str(exc.value)
    assert 'rejected the token' in str(exc.value)


def test_census_resolution_uses_hud_directory_and_keeps_token_off_geocoder(monkeypatch):
    def handler(request):
        if request.url.host=='geocoding.geo.census.gov':
            assert 'Authorization' not in request.headers
            return httpx.Response(200,json={'result':{'addressMatches':[{
                'addressComponents':{'zip':'95336','state':'CA'},
                'geographies':{'Counties':[{'STATE':'06','COUNTY':'077'}]}
            }]}})
        return httpx.Response(200,json=[{'fips_code':'0607799999','county_name':'San Joaquin County'}])
    client=httpx.AsyncClient
    monkeypatch.setattr(hud.httpx,'AsyncClient',lambda **kwargs:client(transport=httpx.MockTransport(handler),**kwargs))
    assert asyncio.run(hud.resolve_area('781 Camino Ct, Manteca, CA 95336'))=='0607799999'


def test_hud_api_returns_benchmark_separately_and_validates_input(client,monkeypatch):
    async def benchmark(*args):
        return hud.normalize(table(),'95336',3,2027)
    monkeypatch.setattr(hud,'benchmark',benchmark)
    response=client.post('/api/hud/benchmarks',json={'year':2027,'properties':[{'address':'A','beds':3}]})
    assert response.status_code==200
    body=response.json()['results'][0]
    assert body['gross_rent']==2990
    assert 'estRent' not in body
    assert 'test-secret' not in json.dumps(response.json())
    assert client.post('/api/hud/benchmarks',json={'properties':[{'beds':-1}]}).status_code==422
    monkeypatch.delenv('HUD_API_TOKEN')
    assert client.get('/api/hud/status').json()['configured'] is False
    assert client.post('/api/hud/benchmarks',json={'properties':[{'beds':3}]}).status_code==400
