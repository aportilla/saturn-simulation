// Probe the time coverage of the Horizons ephemeris for each moon (prints the error text Horizons returns
// for out-of-range requests, which states the available span).
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const ids = process.argv.slice(2);
for (const id of ids) {
  for (const [s, e] of [['1600-01-01', '1600-01-02'], ['2400-01-01', '2400-01-02']]) {
    const qs = `format=text&COMMAND='${id}'&OBJ_DATA='NO'&EPHEM_TYPE='VECTORS'&CENTER='500@699'&START_TIME='${s}'&STOP_TIME='${e}'&STEP_SIZE='1d'&VEC_TABLE='1'`;
    const txt = await (await fetch(`${API}?${qs}`)).text();
    const src = txt.match(/\{source:\s*([^}]+)\}/);
    const err = txt.split('\n').filter((l) => /prior to|after|No ephemeris|ERROR|not available|outside/i.test(l)).slice(0, 3);
    console.log(id, s, src ? src[1] : '-', txt.includes('$$SOE') ? 'OK' : '', err.join(' | '));
  }
}
