// List USGS Astrogeology mosaic files (public S3 bucket behind planetarymaps.usgs.gov/mosaic/) by prefix.
//   node list_usgs.mjs Mimas Phoebe Rhea Tethys Saturn
const base = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/';
for (const p of process.argv.slice(2)) {
  const r = await fetch(`${base}?list-type=2&prefix=${encodeURIComponent('mosaic/' + p)}&max-keys=1000`);
  const x = await r.text();
  const re = /<Key>([^<]+)<\/Key>.*?<Size>(\d+)<\/Size>/gs;
  let m;
  while ((m = re.exec(x))) if (/\.(tif|cub|jpg|png|lbl)$/i.test(m[1])) console.log(`${(+m[2] / 1e6).toFixed(1).padStart(8)} MB  ${m[1]}`);
}
