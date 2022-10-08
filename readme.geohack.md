# [CHIP](https://github.com/totem-man/chip)

Use **CHIP** to chip surface of spherical objects like the earth.  Each chip contains 
a current image chip as well as solar etc information.

## Manage

	npm install @totemstan/chip		# install
	npm run start [ ? | $ | ...]	# Unit test
	npm run verminor				# Roll minor version
	npm run vermajor				# Roll major version
	npm run redoc					# Regen documentation

## Usage

Acquire and optionally configure:

	require("@totemstan/chip").config({
		key: value, 						// set key
		"key.key": value, 					// indexed set
		"key.key.": value					// indexed append
	}, err =>  {
		console.log( err ? "something evil is lurking" : "look mom - Im running!");
	});

where configuration keys follow [ENUMS deep copy conventions](https://github.com/totem-man/enums).


## Program Reference
<details>
<summary>
<i>Open/Close</i>
</summary>
<a name="module_CHIP"></a>

## CHIP
Chip surface of spherical objects like the earth.

**Requires**: <code>module:fs</code>, <code>module:child\_process</code>, <code>module:stream</code>, <code>module:enums</code>  

* [CHIP](#module_CHIP)
    * _static_
        * [.ingestPipe(sql, filter, fileID, src, cb)](#module_CHIP.ingestPipe)
        * [.ingestList(sql, evs, fileID, cb)](#module_CHIP.ingestList)
        * [.ingestFile(sql, path, fileID, cb)](#module_CHIP.ingestFile)
    * _inner_
        * [~POS](#module_CHIP..POS)
        * [~AOI](#module_CHIP..AOI)

<a name="module_CHIP.ingestPipe"></a>

### CHIP.ingestPipe(sql, filter, fileID, src, cb)
Pipe src event stream created for this fileID thru the supplied filter(ev,cache) to the evcache db with callback cb(aoi) when finished.

**Kind**: static method of [<code>CHIP</code>](#module_CHIP)  

| Param | Type | Description |
| --- | --- | --- |
| sql | <code>Object</code> | connector |
| filter | <code>function</code> | the cache(ev) method supplied to filter(ev,cache) adds an event ev {x,y,z,t,s,class,index,state,fileID} to the evcache db. |
| fileID | <code>Number</code> | of internal event store (0 to bypass voxelization) |
| src | <code>Stream</code> | source stream created for this fileID |
| cb | <code>function</code> | Response callback( ingested aoi info ) |

<a name="module_CHIP.ingestList"></a>

### CHIP.ingestList(sql, evs, fileID, cb)
Ingest events list to internal fileID with callback cb(aoi) when finished.

**Kind**: static method of [<code>CHIP</code>](#module_CHIP)  

| Param | Type | Description |
| --- | --- | --- |
| sql | <code>Object</code> | connector |
| evs | <code>Array</code> | events [ ev, ... ] to ingest |
| fileID | <code>Number</code> | of internal event store (0 to bypass voxelization) |
| cb | <code>function</code> | Response callback( ingested aoi info ) |

<a name="module_CHIP.ingestFile"></a>

### CHIP.ingestFile(sql, path, fileID, cb)
Ingest events in evsPath to internal fileID with callback cb(aoi).
	Ingest events in a file to the internal events file.

**Kind**: static method of [<code>CHIP</code>](#module_CHIP)  

| Param | Type | Description |
| --- | --- | --- |
| sql | <code>Object</code> | connector |
| path | <code>String</code> | to events file containing JSON or csv info |
| fileID | <code>Number</code> | of internal event store (0 to bypass voxelization) |
| cb | <code>function</code> | Response callbatck( ingested aoi info ) |

<a name="module_CHIP..POS"></a>

### CHIP~POS
POS
Curved earth functions conventions:

	t,cols,x,y,lat,gtp[0]
	s,rows,y,lon,gtp[1]
	old poly = TL,TR,BL,BR,TL
	new poly = TL,TR,BR,BL
	top = ortho north

**Kind**: inner class of [<code>CHIP</code>](#module_CHIP)  
<a name="module_CHIP..AOI"></a>

### CHIP~AOI
AOI
ring = [ [lat,lon], .... ] degs defines aoi
chipFeatures = number of feature across chip edge
chipPixels = number of pixels across chip edge
chipDim = length of chip edge [m]
overlap = number of features to overlap chips
r = surface radius [km]  6147=earth 0=flat

**Kind**: inner class of [<code>CHIP</code>](#module_CHIP)  
</details>

## Contacting, Contributing, Following

Feel free to 
* submit and status [TOTEM issues](http://totem.hopto.org/issues.view) 
* contribute to [TOTEM notebooks](http://totem.hopto.org/shares/notebooks/) 
* revise [TOTEM requirements](http://totem.hopto.org/reqts.view) 
* browse [TOTEM holdings](http://totem.hopto.org/) 
* or follow [TOTEM milestones](http://totem.hopto.org/milestones.view) 

## License

[MIT](LICENSE)

* * *

&copy; 2012 ACMESDS