// UNCLASSIFIED

/**
Chip surface of spherical objects like the earth.

@module CHIP
@requires fs
@requires child_process
@requires stream
@requires enums
*/
const   
	// globals
	ENV = process.env,
	TRACE = "G>",
	
	// nodejs modules
	FS = require("fs"), 
	CP = require("child_process"),
	STREAM = require("stream");

const { Copy,Each,Log,Debug,isString,isArray,Extend,Fetch } = require("@totemstan/enums");

const { Trace } = CHIP = module.exports = {
	
	Trace: (msg, ...args) => `geohack>>>${msg}`.trace( args ),
	
	aoi: null, 			//< current aoi being processed
	limit: 1e99, 		//< max numbers of chips to pull over any aoi

	make: {   //< methods to make objects being cached 
		chip: function makeChip( fetch, parms, cb ) {
			var chip = parms;

			// change logic here. sql.cache should return chip path.  dogCache will remove from cache if aged.
			// so here must always fetch the chip into the file path, then add it in the sql.cache
			
			/*
			FS.stat(chip.path, err => { // check if chip in file cache
				if (err)  // not in cache so prime it
					Fetch( CHIP.paths.images.tag("?", parms ) + "////" +  chip.path, null, rtn => {
						Log("fetch chip", parms.path, rtn);
						cb( rtn ? chip : null );
					});

				else // in cache
					cb(chip);
			});  */
		},

		flux: function makeFlux( fetch, parms, cb) {
			var tod = parms.tod;
			cb( new SOLAR( tod.getJulian(), tod.getHours()/24, tod.getTimezoneOffset()/60, parms.lat, parms.lon) );
		},

		collects: function makeCollects( fetch, parms, cb) {
			Fetch( CHIP.paths.catalog.tag("?", parms), info => cb( info.parseJSON( [] ) ) );
		}
	},				
	
	ringRadius: function (ring) {  //< methods used to comute radius of a geometry ring
		/*
		Haversine functions to compute arc length on sphere of radius r
		*/
		const {cos,sin,asin,sqrt,PI} = Math;
		
		function hsine(theta) { return (1-cos(theta))/2; }  // havesine between two anchors subtending angle theta
		function ahsine(h12) { return 2 * asin(sqrt(h12)); }
		function hdist(h12,r) { return r * ahsine(h12); }
		function hsine2(lat,lon) {   // between 2 pts on great circle
			var
				dlat = lat[1] - lat[0],
				dlon = lon[1] - lon[0];
			
			return hsine(dlat) + cos(lat[0]) * cos(lat[1]) * hsine(dlon);
		}  

		var 
			c = PI / 180,
			TL = ring[0][0], // top-left corner
			BR = ring[0][2], // bottom-right corner
			lat = [ c*TL.y, c*BR.y ],  // [from, to] in [rads]
			lon = [ c*TL.x, c*BR.x ],  // [from, to] in [rads]
			h12 = hsine2(lat,lon);
		
		return hdist(h12, 6137)/2; //  [km]
	},
	
	getVoxels: function ( sql, pipe, file, cb ) {  
	/**
	Chip voxels defined by the pipe:
	
		"PIPE NAME" || 	
		{
			file: "PLUGIN.CASE" || "/DATASET?QUERY" || [ ev, ev, ... ] || ev
			group: "KEY,..." || ""  
			where: { KEY: VALUE, ...} || {}  
			order: "KEY,..." || "t"  
			limit: VALUE || 1000  
			task: "NAME" || ""  
			aoi: "NAME" || [ [lat,lon], ... ] || []	
		}
	
	with calbacks to cb({File, Voxel, Events, Flux, Stats, Sensor, Chip}) for each voxel accessed.
	**/
		function getMeta( aoi, soi, file, voxel, cb ) {

			function toJSON(key) {
				try {
					return JSON.parse(key);
				}
				catch (err) {
					return null;
				}
			}

			function cache( opts, cb ) {
				var
					key = opts.key || "",
					parms = opts.parms || {},
					rec = CHIP.cache[key];

				if ( rec )
					cb( rec );

				else
				if ( make = opts.make ) 
					make( Fetch, parms, (rec,parms) => cb( CHIP.cache[key] = new Object(rec) ) );
			}

			var
				rows = pipe.rows || 100,
				cols = pipe.cols || 100,
				limit = pipe.limit || 1000,
				offset = pipe.offset || 0,
				order = pipe.order || "t",
				fields = pipe.fields || "*";

			cache({ 
				key: `flux-${voxel.lon}-${voxel.lat}`,
				parms: { 
					lat: voxel.lat,
					lon: voxel.lon,
					tod: new Date()
				},
				make: CHIP.make.flux
			}, flux => {	// get solar flux over this aoi
				cache({ 
					key: `collect-${voxel.lon}-${voxel.lat}-${rows}-${cols}`,
					parms: { 
						ring: aoi, 
						src: "spoof", 
						width: cols, 
						height: rows
					},
					make: CHIP.make.collects
				}, chips => {	// get sensor collects over this aoi
					//Log("cached", flux, voxel);
					if ( ag )		// aggregate all voxels above this chip (i.e. look at only surface voxels)
						sql.forFirst(
							TRACE,
							"SELECT * FROM app._stats WHERE least(?)", 
							[ {fileID: file.ID, voxelID: voxel.ID} ], stats => {  // get saved stats on this file-voxel pair

							cb({
								File: file,
								Voxel: voxel,
								Events: sql.format(	// generate event getter
										`SELECT ${fields} FROM app.events WHERE ? AND MBRcontains(geomfromtext(?),Point(x,y)) ORDER BY ${order} LIMIT ? OFFSET ?`,
										[{fileID: file.ID}, toPolygon(aoi), limit, offset]  ),
								Flux: flux,
								Stats: stats,
								Chips: chips
							});
						});

					else
						sql.forEach( // get each voxel above this chip
							TRACE,
							"SELECT * FROM app.voxels WHERE ? AND enabled",
							[ {chipID: voxel.chipID} ], voxel => {

								//Log("vox above", voxel);
								sql.forFirst( // get stats on this file-voxel pair
									TRACE,
									"SELECT * FROM app._stats WHERE least(?)", 
									[ {fileID: file.ID, voxelID: voxel.ID} ], stats => {

									cb({
										File: file,
										Voxel: voxel,
										Events: sql.format(	
												`SELECT ${fields} FROM app.events WHERE least(?,1) ORDER BY ${order} LIMIT ? OFFSET ?`,
												[{voxelID: voxel.ID, fileID: file.ID}, limit, offset]  ), 
										Flux: flux,
										Stats: stats,
										Chips: chips
									});

								}); 
							});	

				});

			});
		}
			
		function chipper( aoi, voi, soi, file, ag, cb) {  // area-, voxel-, senor- of interest; aggregate flag

			//Log("chip", {aoi: aoi, voi: voi, soi: soi, pipe:pipe, file:file} );

			var aoiPoly = toPolygon(aoi);
			
			if (ag) 	// looking at surface super voxel having specified class name
				sql.forEach( get.msg, get.surfaceVoxels, [ aoiPoly, {minAlt:0, Ag:1} ], voxel => { // get the super voxel
				sql.forAll( get.msg, get.surfaceVoxels, [ aoiPoly, voi ], voxels => {	// get its sub voxels
					getMeta( aoi, soi, file, voxel, meta => {
						var 
							states = meta.States = file.Stats_stateSymbols = [],
							keys = file.Stats_stateKeys = {index:"index", state:"voxelID"};

						voxels.forEach( (voxel,state) => {
							states.push( state );
						});

						Log("chip states", voxel.ID, states);

						cb(meta);
					});
				});
				});

			else // pull all surface voxels falling in specified aoi having specified voi attributes
				sql.forEach( get.msg, get.surfaceVoxels, [ aoiPoly, voi ], voxel => {							
					getMeta( aoi, soi, file, voxel, meta => cb(meta) );
				});

		}

		var
			aoi = pipe.aoi,
			soi = pipe.soi || {},
			voi = pipe.voi || true,
			ag = pipe.ag || pipe.surface || pipe.supper,
			get = {
				rings: "SELECT Ring FROM app.aois WHERE ?",
				//chips: `SELECT ${group} FROM app.events GROUP BY ${group} `,
				//voxels: "SELECT * FROM app.voxels WHERE ?", 
				voxelsByRef: "SELECT voxelID FROM app.events WHERE ? GROUP BY voxelID",
				voxelsByID: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE ? AND enabled GROUP BY chipID",
				surfaceVoxels: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE MBRcontains(GeomFromText(?), voxels.Ring) AND least(?,1) AND enabled GROUP BY chipID ORDER BY ID",
				dummyVoxels: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE Ring IS null AND enabled GROUP BY chipID ORDER BY ID",
				//agVoxels: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE MBRcontains(GeomFromText(?), voxels.Ring) AND least(?,1) GROUP BY chipID",
				//chips: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE MBRcontains(GeomFromText(?), voxels.Ring) AND least(?,1) ORDER BY ID",
				//files: "SELECT * FROM app.files WHERE Name LIKE ? ",
				msg: TRACE
			};

		if (aoi)
			if ( isString(aoi) )  // chip all named aois
				sql.forEach( get.msg, get.rings, {Name:aoi}, aoi => {
					chipper( JSON.parse(aoi.Ring), voi, soi, file, ag, meta => cb(meta) );
				});

			else   // chip events inside specified aoi
				chipper( aoi, voi, soi, file, ag, meta => cb(meta) );
		
		else
		if ( file.Ring)		// pull all surface voxels over specified file having specified voi attributes
			chipper( toRing(file.Ring), voi, soi, file, ag, meta => cb(meta) );
			/*sql.forEach( get.msg, get.surfaceVoxels, [ toPolygon(toRing(file.Ring)), voi ], voxel => {
				getMeta( aoi, soi, file, voxel, meta => cb(meta) );
			});*/
		

		/*
		else
		if (file.ID)	// pull all voxels by event refs and stack them by chipID
			sql.query( get.voxelsByRef, {fileID: file.ID})
			.on("result", ev => {
				if ( ev.voxelID )
					sql.forEach( get.msg, get.voxelsByID, {ID: ev.voxelID}, voxel => {
						//Log("chipped voxel", voxel);
						getMeta( aoi, soi, file, voxel, meta => cb(meta) );
					});

				else
					sql.forEach( get.msg, get.dummyVoxels, [ ], voxel => {
						getMeta( aoi, soi, file, voxel, meta => cb(meta) );
					});
			})
			.on("error", err => Log("youch", err) );

		else	// pull default/dummy/null voxel
			sql.forEach( get.msg, get.dummyVoxels, [ ], voxel => {
				getMeta( aoi, soi, file, voxel, meta => cb(meta) );
			});
		*/
	},
	
	ingestCache: function (sql, fileID, eventClass, cb) { 
	/** 
	Ingest the evcache db for the given fileID into the events db then callback cb(aoi)
	@param {Object} sql connector
	@param {Number} fileID of internal event store (0 to bypass voxelization)	
	@param {Function} cb Response callback( ingested aoi info )
	*/		
		sql.forAll(  // ingest evcache into events history by determining which voxel they fall within
			"INGEST",
			fileID 
				// voxelize the events
				? "INSERT INTO app.events SELECT evcache.*,voxels.ID AS voxelID FROM app.evcache " 
						+ "LEFT JOIN app.voxels ON least( " + [
								"MBRcontains(voxels.Ring,point(evcache.x,evcache.y))" ,
								"evcache.z BETWEEN voxels.alt AND voxels.alt+voxels.height",
								"?",
								"voxels.enabled"
							].join(", ") + ") WHERE ? HAVING voxelID"

				// bypass voxelization
				: "INSERT INTO app.events SELECT *, 0 AS voxelID FROM app.evcache WHERE ?" ,
			
			[{"voxels.class": eventClass}, {"evcache.fileID": fileID}],
			
			ingest => {
				
			sql.forFirst(
				"INGEST",
				
				"SELECT "
				+ "? AS Voxelized, "
				+ "? AS Class, "
				+ "min(x) AS xMin, max(x) AS xMax, "		// lat [degs]
				+ "min(y) AS yMin, max(y) AS yMax, "		// lon [degs]
				+ "min(z) AS zMin, max(z) AS zMax, "		// alt [km]
				+ "floor(max(t)) AS Steps, "		// steps [ms]
				+ "max(u)+1 AS States, "		// number of states
				+ "max(n)+1 AS Actors, "		// ensemble size
				+ "count(id) AS Samples "		// samples ingested
				+ "FROM app.evcache WHERE ?", 
				
				[ ingest.affectedRows, eventClass, {fileID:fileID} ],	cb);
				
		});
	},

	/**
	Pipe src event stream created for this fileID thru the supplied filter(ev,cache) to the evcache db with callback cb(aoi) when finished.
	
	@param {Object} sql connector
	@param {Function} filter the cache(ev) method supplied to filter(ev,cache) adds an event ev {x,y,z,t,s,class,index,state,fileID} to the evcache db.	
	@param {Number} fileID of internal event store (0 to bypass voxelization)	
	@param {Stream} src source stream created for this fileID
	@param {Function} cb Response callback( ingested aoi info )	
	*/
	ingestPipe: function (sql, filter, fileID, eventClass, src, cb) {  
		sql.query("DELETE FROM app.evcache WHERE ?", {fileID: fileID});

		sql.query("SELECT PoP_Start FROM app.files WHERE ? LIMIT 1", {ID: fileID}, function (err, ref) {
			
			var 
				ingested = 0,
				refTime = ref[0].PoP_Start,
				sink = new STREAM.Writable({
					objectMode: true,
					write: function (rec,en,cb) {

						function cache(ev) {

							ingested++;
							
							sql.query(
								"INSERT INTO app.evcache SET ?", [{
									x: ev.x || 40.54933526,		// lat [degs]
									y: ev.y || 37.41501485,		// lon [degs]
									z: ev.z || 0,		// alt [km]
									t: ev.t || 0,		// sample time [ms]
									s: ev.s || (ev.t - refTime), 		// relative steps [ms]
									n: ev.n || 0,		// unqiue id 
									u: ev.u || 0,		// current state 
									k: ev.k || 0, // class type
									fileID: fileID		// source file
								}
							] );
						}

						if (filter)   // filter the record if filter provided
							filter(rec, cache);

						else  // no filter so just cache the record
							cache(rec);

						cb(null);  // signal no errors
					}
				});
		
			sql.beginBulk();
		
			sink
			.on("finish", () => {

				sql.endBulk();

				Trace(`INGEST ${ingested} EVENTS FROM FILE${fileID}`);

				if ( ingested )  // callback if there were ingested events
					CHIP.ingestCache(sql, fileID, eventClass, aoi => {
						//Log("ingest cb", cb);
						cb(aoi);

						var
							TL = [aoi.yMax, aoi.xMin],   // [lon,lat] degs
							TR = [aoi.yMax, aoi.xMax],
							BL = [aoi.yMin, aoi.xMin],
							BR = [aoi.yMin, aoi.xMax], 
							Ring = [ TL, TR, BR, BL, TL ];

						//Trace("INGESTED "+fileID);
						sql.query(  // update file with aoi info
							"UPDATE app.files SET ?, _Ingest_Samples=_Ingest_Samples+?, _Ingest_Rejects=_Ingest_Rejects+?, _Score_Relevance=1-_Ingest_Rejects/_Ingest_Samples WHERE ?", [{ 
								_Ingest_States: aoi.States,
								_Ingest_Steps: aoi.Steps,
								_Ingest_Actors: aoi.Actors,
								_State_Graded: false,
								_State_Pruned: false,
								_State_Archived: false
							},
							aoi.Voxelized,
							aoi.Samples - aoi.Voxelized,
							{ID: fileID} 
						]);

					});

			})
			.on("error", err => {
				sql.endBulk();
				//Log("INGEST FAILED", err);
			});
		
			src.pipe(sink);  // start the ingest
		});
	},
	
	/**
	Ingest events list to internal fileID with callback cb(aoi) when finished.
	
	@param {Object} sql connector
	@param {Array} evs events [ ev, ... ] to ingest
	@param {Number} fileID of internal event store (0 to bypass voxelization)	
	@param {Function} cb Response callback( ingested aoi info )
	*/
	ingestList: function (sql, evs, fileID, eventClass, cb) {
		//Trace(`INGEST ${evs.length} EVENTS FILE ${fileID}`);
		
		var 
			n = 0, N = evs.length,
			src = new STREAM.Readable({  // source stream for event ingest
				objectMode: true,
				read: function () {  // return null if there are no more events
					this.push( evs[n++] || null );
				}
			});
		
		CHIP.ingestPipe(sql, null, fileID, eventClass, src, cb);
	},
	
	/**
	Ingest events in evsPath to internal fileID with callback cb(aoi).
	Ingest events in a file to the internal events file.
	
	@param {Object} sql connector
	@param {String} path to events file containing JSON or csv info
	@param {Number} fileID of internal event store (0 to bypass voxelization)
	@param {Function} cb Response callbatck( ingested aoi info )
	*/
	ingestFile: function (sql, evsPath, fileID, eventClass, cb) {  
		function filter(buf, cb) {
			buf.split("\n").forEach( rec => {
				if (rec) 
					try {
						var data = JSON.parse(rec);
						
						if ( data )
							switch (data.constructor) {
								case Array: 
									data.each( function (n,rec) {
										cb(rec);
									});
									break;
									
								case Object:
									cb( data );
									break;
									
								default: 
									cb( {t: data} );
							}
					}
					
					catch (err) {
						var vals = rec.split(",");
						cb( { x: parseFloat(vals[0]), y: parseFloat(vals[1]), z: parseFloat(vals[2]), t: parseFloat(vals[3]), n: parseInt(vals[4]), u: parseInt(vals[5]) } );
					}
			});	
		}
		
		var
			src = FS.createReadStream(evsPath,"utf8");
		
		CHIP.ingestPipe(sql, filter, fileID, eventClass, src, cb);
	},
		
	ingestService: function (url, fetch, chan, cb) {  // ingest events from service channel
		var
			tmin = chan.tmin,
			tmax = chan.tmax;
		
		CHIP.sqlThread( function (sql) {	
			Fetch( url.tag("?", {tmin:tmin,tmax:tmax}), events => {
				var 
					n = 0,
					evs = events.parseJSON( [] ),
					str = CHIP.ingestStream( sql, "guest", function () {
						var ev = evs[n++];
						this.push( ev ? JSON.stringify([ev.x,ev.y,ev.z,ev.n]) : null );
					}).pipe( str );
			});
		});
	},	
			
	sqlThread: () => { throw "geohack - sqlThread unconfigured"; },  //< sql threader
	//fetch: () => { throw "geohack - fetch unconfigured"; },  //< http data fetch
	
	errors: {
		nowfs: new Error("chipping catalog service failed"),
		nowms: new Error("chipping service failed to provide a wms url"),
		noStepper: new Error("engine does not exist, is not enabled, or lost stepper")
	},
	
	/*
	tagCollect: function (chip, cb) {  // process all collects associated with requested chip with callback cb(chip) 
		Each(CHIP.collects, function (n,collect) {  // tag chip with collect info
			cb( Copy(collect, chip) );
		});
	}, */
	
	cache: {},
	
	paths: {
		chips: "./stash/images.chips", //ENV.SRV_TOTEM+"/shares/spoof.jpg", //ENV.WMS_TOTEM,
		catalog: "/wfs",
		tips: "./stash/images/tips"
	},

	models: { // forecasting models
		default: {
			name: "default",
			srcs: ["pos-0.jpg", "pos-1.jpg", "pos-2.jpg", "pos-3.jpg"],
			rots: [0], 
			scales: [1],
			flips: [""],
			levels: [0,1,5,10,20,50,70,90]
		},
		none: null,
		lite: {
			name: "lite",
			srcs: ["pos-0.jpg", "pos-1.jpg", "pos-2.jpg", "pos-3.jpg"],
			rots: [0], 
			scales: [1],
			flips: [""],
			levels: [0,5,10]
		},
		debug: {
			name: "debug",
			srcs: ["pos-0.jpg", "pos-1.jpg", "pos-2.jpg", "pos-3.jpg"],
			rots: [0,90,45], 
			scales: [1],
			flips: ["x","y","xy"],
			levels: [0,5,10]
		}
	},
	
	spoof: {
		file: "",
		layer: "",
		ring: [
			[70.0899, 33.9108], // TL lon,lat [degs]
			[70.0988, 33.9018], // TR
			[70.0988, 33.9105], // BR
			[70.0899, 33.9105] // BL
		]
		// [ [70.0899, 33.9108], [70.0988, 33.9018], [70.0988, 33.9105], [70.0899, 33.9105] ]
		// [70.0899,33.9018],[70.0990,33.9105],[70.0902,33.9109], [70.0988,33.9016],
	},
	
	config: function (opts,cb) {  //< configure it
		
		if (opts) Copy(opts, CHIP, ".");
		
		/*
		if ( streamingWindow = CHIP.streamingWindow)
			CHIP.ingestStreams(streamingWindow, function (twindow,status,sql) {
				console.log(twindow,status);
			}); */			

		if (cb) cb(null);
		return CHIP;
	},
	
	detectAOI: function (sql, aoicase) {
	
		CHIP.chipAOI(sql, aoicase, chip => {
			Log("detecting chip", chip.bbox);
		});
	},
	
	// chippers
	
	voxelizeAOI: function (sql, query) {
		
		var now = new Date();
		
		const {sqrt} = Math;

		sql.beginBulk();   // speeds up voxel inserts but chipID will be null
		
		Log("voxelize", query);
		
		CHIP.chipAOI(sql, query, chip => {
			if ( chip ) {
				Log("make voxels above", chip.ring);

				sql.query("INSERT INTO app.chips SET ?, Ring=GeomFromText(?), Point=GeomFromText(?)",  [{
					x: chip.pos.lat,  // [degs]
					y: chip.pos.lon,	// [degs]
					t: 0,
					class: query.Name,
					rows: chip.rows, // lat direction [pixels]
					cols: chip.cols // lon direction [pixels]
				}, toPolygon(chip.ring),	// [degs]
					toPoint([ chip.pos.lat, chip.pos.lon ])  // [degs]
				],  (err, chipInfo) => {
					if ( !err ) 	// chip created so need to create voxels above
						for (var alt=0, n=0; n<query.voxelCount; n++,alt+=query.voxelHeight)  { // define voxels above this chip
							sql.query(
								//"INSERT INTO app.voxels SET ?, Ring=GeomFromText(?), Anchor=GeomFromText(?)", [{
								"INSERT INTO app.voxels SET ?, Ring=GeomFromText(?)", [{
									enabled: true,
									class: query.Name,
									lon: chip.lon,
									lat: chip.lat,
									alt: alt,
									length: chip.width,
									width: chip.height,
									height: query.voxelHeight,
									chipID: chipInfo.insertId,
									radius: sqrt(chip.width**2 + chip.height**2),
									added: now,
									minSNR: 0
								}, toPolygon(chip.ring) ], err => Log("ins vox", err)
							);
						}
				});
			}

			else
				sql.endBulk();	
		});
	},
	
	chipAOI: function (sql, query, cb) {
		var
			ring = query.ring, // [ [lat, lon], ...] degs
			chipFeatures = query.chipFeatures, // [ features along edge ]
			chipPixels = query.chipPixels, // [pixels]
			featureDim = query.featureLength, // [m]
			featureOverlap = query.featureOverlap, // [features]
			chipDim = featureDim * chipFeatures,  // [m]
			surfRadius = query.radius,  // [km]  6147=earth 0=flat
			aoi = new AOI( ring, chipFeatures, chipPixels, chipDim, featureOverlap, surfRadius);

		Log("chipAOI", {
			aoi: query, 
			overlap_features: featureOverlap,
			chip_features: chipFeatures,
			chip_pixels: chipPixels,
			chip_m: chipDim,
			feature_m: featureDim
		});
		
		aoi.getChips( query, cb );	
	}
	
};

function SOLAR(day,tod,tz,lat,lon) {
	var D2R = Math.PI / 180, R2D = 1/D2R;
	
	function sin(x) { return Math.sin(D2R * x); }
	function cos(x) { return Math.cos(D2R * x); }
	function tan(x) { return Math.tan(D2R * x); }
	function tan(x) { return Math.tan(D2R * x); }
	function atan2(x,y) { return R2D * Math.atan2(x,y); }  // was atan2(x)
	function asin(x) { return R2D * Math.asin(x); }
	function acos(x) { return R2D * Math.acos(x); }
	//function pow(x,a) { return Math.pow(x,a); }
	
	this.day = day;
	this.tod = tod;  // local time of day [hours past midnight]
	this.tz = tz; // local time zone [1-24]
	this.lat = lat; //	local latitude [deg]
	this.lon = lon; // local longitude [deg]
	
	var 
		jday = this.jday = day + 2415018.5 + tod - tz/24, // julian day from GMT noon jan 1, 4713 bc
		jcen = this.jcen = (day - 2451545) / 36525,  // julian century
		gml = this.gml = (280.46646 + jcen * (36000.76983 + jcen * 0.0003032)) % 360, // solar geometric mean lon [deg]
		gma = this.gma = 357.52911 + jcen * (35999.05029 - 0.0001537 * jcen), // solar geometric mean anam
		eeo = this.eeo = 0.016708634 - jcen * (0.000042037 + 0.0000001267 * jcen),  // eccentricity of earth orbit
		sec = this.sec = sin(gma) * (1.914602 - jcen*(0.004817 + 0.000014 * jcen))
			+ sin(2*gma) * (0.01993 - 0.000101*jcen)
			+ sin(3*gma) * 0.000289, // sun eqn of center [deg]
		srl = this.srl = gml + sec, // sun true lat [deg]
		sta = this.sta = gma + sec,  // sun true anom
		srv = this.srv = (1.000001018*(1-eeo*eeo)) / (1 + sec*cos(sta)), // sun radial vector [AUs]
		sal = this.sal = srl - 0.0059 - 0.00478 * sin(125.04 - 1934.136 * jcen), // sun app lon [deg]  (srl was stl?)
		moe = this.moe = 23 + (26 + ((21.448 - jcen*(46.815 + jcen * (0.0059 - jcen*0.001813)))) / 60) / 60, // mean obliq ecliptic [deg]
		oc = this.oc = moe + 0.00256 * cos(125.04 - 1934.136*jcen),  // obliq correction [deg]
		sra = this.sra = atan2( cos(sal), cos(oc) * sin(sal) ),  // sun right ascention [deg]
		sde = this.sde = asin( sin(oc) * sin(sal)),  // sun declination [deg]
		//vary = this.vary = pow( tan( oc/2 ), 2),   // var y
		vary = this.vary = tan( oc/2 ) ** 2,   // var y
		eot = this.eot = 4*R2D*( vary * // equation of time [min]
					  sin(2*gml) 
					  - 2*eeo * sin(gma)
					  + 4*eeo*vary*sin(gma)*cos(2*gml)
					  - 0.50*vary*vary*sin(4*gml)
					  - 1.25*eeo * eeo * sin(2*gma) ),
					  
		sr = this.sr = acos( cos(90.833) / (cos(lat)*cos(sde)) - tan(lat) * tan(sde) ), // sunrise [deg]
		sn = this.sn = (720 - 4*lon - eot + tz*60) / 1440,  // solar noon (LST)
		sd = this.sd = 8*sr,  // solar duration [mins]
		srt = this.srt = sn - sr * 4/1440,  // sunrise time (LST)
		sst = this.sst = sn + sr * 4/1440,  // sunset time(LST)
		tst = this.tst = (tod*1440 + eot + 4*lon -tz*60) % 1440,  // true solar time [min]
		// note: tst will not agree with the spreadsheet for negative modulo arguments, but not used
		ha = this.ha = (tst/4 < 0)  // hour angle [deg]
			? tst/4 + 180
			: tst/4 - 180,
		sza = this.sza = acos( sin(lat)*sin(sde) + cos(lat)*cos(sde)*cos(ha) ),  // solar zenith angle from local horizon [deg]
		sea = this.sea = 90 - sza,  // solar elevation angle from local normal [deg]
		ari = this.ari = (
				(ha > 85)  // approx atm refractive index
					? 0
					: (sea > 5) 
						//? 58.1/tan(sea) - 0.07/pow(tan(sea),3) + 0.000086/pow(tan(sea),5)
						? 58.1/tan(sea) - 0.07/tan(sea)**3 + 0.000086/tan(sea)**5
						: (sea  > -0.575)
							? 1735 + sza*(-518.2 + sea*(103.4 + sea*(-12.79 + sea*0.7111)))
							: -20.772 / tan(sea) 
			) / 3600,
			
		csea = this.csea = sea + ari, // sun elev angle corrected for atm refraction [deg]
		
		csza = this.csza = (ha>0) 			// sun zenith angle [deg clockwise from N]
					? (180 + acos( (sin(lat)*cos(sza) - sin(sde)) / (cos(lat)*sin(sza)) )) % 360 
					: (540 - acos( (sin(lat)*cos(sza) - sin(sde)) / (cos(lat)*sin(sza)) )) % 360;
	
}

/**
@class POS
Curved earth functions conventions:

	t,cols,x,y,lat,gtp[0]
	s,rows,y,lon,gtp[1]
	old poly = TL,TR,BL,BR,TL
	new poly = TL,TR,BR,BL
	top = ortho north
*/
function POS(x,y) { 
	this.x = x; this.y = y; return this; 
}

[
	function map(c) { return [this.x*c, this.y*c]; },
	function add(u) { this.x += u.x; this.y += u.y; return this; },
	function sub(u) { this.x -= u.x; this.y -= u.y; return this; },
	function scale(a) { this.x *= a; this.y *= a; return this; },
	function set(u) { this.x *= u.x; this.y *= u.y; return this; },
	function copy() { return new POS(this.x,this.y); }
].Extend(POS);

/**
@class AOI
ring = [ [lat,lon], .... ] degs defines aoi
chipFeatures = number of feature across chip edge
chipPixels = number of pixels across chip edge
chipDim = length of chip edge [m]
overlap = number of features to overlap chips
r = surface radius [km]  6147=earth 0=flat
*/
function AOI( ring,chipFeatures,chipPixels,chipDim,overlap,r ) {  // build an AOI over a ring to accmodate specifed chip
	const {cos, acos, sin, asin, random, round, floor, min, max, sqrt, PI} = Math;

	/*
	Haversine functions to compute arc length on sphere of radius r
	*/
	/*
	function hsine(theta) { return (1-cos(theta))/2; }  // havesine between two anchors subtending angle theta
	function ahsine(h12) { return 2 * asin(sqrt(h12)); }
	function hdist(h12,r) { return r * ahsine(h12); }
	function hsine2(lat,lon) {   // between 2 pts on great circle
		var
			dlat = lat[1] - lat[0],
			dlon = lon[1] - lon[0];

		return hsine(dlat) + cos(lat[0]) * cos(lat[1]) * hsine(dlon);
	}  */ 
	
	/*
	lat-lon ranges
	*/
	function minlat(TL,BL,TR,BR) { return min(TL.x,BL.x,TR.x,BR.x); }
	function minlon(TL,BL,TR,BR) { return min(TL.y,BL.y,TR.y,BR.y); }
	function maxlat(TL,BL,TR,BR) { return max(TL.x,BL.x,TR.x,BR.x); }
	function maxlon(TL,BL,TR,BR) { return max(TL.y,BL.y,TR.y,BR.y); }

	var
		aoi = this,
		c = aoi.c = 180 / Math.PI,
		TL = aoi.TL = ring[0].pos(c), 		// [lon,lat] degs -> {x:lat,y:lon} rads
		TR = aoi.TR = ring[1].pos(c),
		BR = aoi.BR = ring[2].pos( c),
		BL = aoi.BL = ring[3].pos(c),
		lat = minlat(TL,BL,TR,BR),				// initial lat [rad]
		lon = minlon(TL,BL,TR,BR),			// initial lon [rad]
		ol = aoi.ol = overlap/chipFeatures, 							// % chip overlap
		//r = aoi.r = 6137, 								// earth radius [km]
		featureDim = aoi.featureDim = chipDim / chipFeatures;   // feature dim [m]
	
	if (r)   // curved earth
		var
			//chipDim = aoi.chipDim = chipFeatures * featureDim/1000,			// chip dimension [km]
			du = aoi.du = 2*sin( (chipDim/1000) / (2*r) ) ** 2, // angle formed
			dlon = acos(1 - du), 							// delta lon to keep chip height = chip width = chipDim
			dlat = acos( 1 - du / cos(lat) ** 2 ); 	// delta lat to keep chip height = chip width = chipDim
	
	else   // flat earth
		var
			du = aoi.du = featureDim/c,	// [ "degs" -> "rads" ]
			dlon = du,
			dlat = du;
		
	// curved surface note: dlat -> inf when lat -> +/- 90 ie when at the poles.  Stay off the poles!
	
	//console.log({aoi:ring,number_of_features:chipFeatures,number_of_samples:chipPixels,chipDim:chipDim,
	// featureDim:featureDim,lat:lat,lon:lon,dels: [dlat,dlon], ol:ol});	
	
	aoi.r = r; // surface radius [km] 0 implies flat  6137 km for earth
	
	//Log("aoi", aoi.r, du, dlon, dlat);
	
	aoi.csd = chipDim / chipPixels; 		// chip sampling dimension [m]
	aoi.gfs = round(chipPixels/chipFeatures);	// ground feature samples [pixels]
	aoi.chipPixels = chipPixels;  // samples across chip edge [pixels]
	aoi.chipFeatures = chipFeatures;  // features along a chip edge
	//aoi.featureDim = featureDim; // feature edge dimension [m]
	//aoi.mode = "curvedearth";
	
	aoi.lat = {min:lat, max:maxlat(TL,BL,TR,BR), ol:ol, pixels:chipPixels, del:dlat, val:lat, dim:chipDim, idx:0};
	aoi.lon = {min:lon, max:maxlon(TL,BL,TR,BR), ol:ol, pixels:chipPixels, del:dlon, val:lon, dim:chipDim, idx:0};
	
	aoi.lat.steps = floor( (aoi.lat.max - lat) / dlat );
	aoi.lon.steps = floor( (aoi.lon.max - lon) / dlon );
	
	//Log(lat, dlat, 1 - u / pow(cos(lat),2) );
	//Log(aoi.lat, aoi.lon, [TL, BL, TR, BR]);
	
	aoi.org = TL.copy();
	aoi.ext = {		// chip step with no overlap
		lat:BL.copy().sub(TL).scale(dlat),
		lon:TR.copy().sub(TL).scale(dlon) 
	};  
	aoi.adv = {  // chip step with overlap
		lat: BL.copy().sub(TL).scale(dlat*(1-ol)),
		lon:TR.copy().sub(TL).scale(dlon*(1-ol)) 
	};
}

[
	function hasChip(aoicase,cb) { // return true if aoi still has a chip to process
		var
			aoi = this,
			lat = this.lat,
			lon = this.lon,
			withinAOI = aoi.chips++ < CHIP.limit && lat.idx <= lat.steps; //lat.val <= lat.max;
		
		//Log(aoi.chips, lat.idx, lon.idx);
		
		return withinAOI;	
	},

	function getChips(aoicase,cb) {  // start regulated chipping 
		var aoi = this;
		
		aoi.chips = 0;  // reset chip counter
		
		while ( aoi.hasChip( aoicase ) ) cb( new chipper(aoi) );
		cb( null );  // signal chipping process done
	}
].Extend(AOI);

function chipper(aoi) {
	var
		cos = Math.cos,
		acos = Math.acos,	
		eps = {pos: 0.00001, scale:0.01},
		lat = aoi.lat,  
		lon = aoi.lon, 
		c = aoi.c,
		pos = this.pos = {lat: lat.val*c, lon: lon.val*c};    // [degs]
	
	this.min = {lat: pos.lat*(1-eps.pos), lon:pos.lon*(1-eps.pos), scale:aoi.scale*(1-eps.scale)};  // [degs]
	this.max = {lat: pos.lat*(1+eps.pos), lon:pos.lon*(1+eps.pos), scale:aoi.scale*(1+eps.scale)};  // [degs]
	//this.index = ("000"+lat.idx).substr(-3) + "_" + ("000"+lon.idx).substr(-3);
	//this.aoi = aoi;
	this.gfs = aoi.gfs; //  number of samples across a feature
	this.sites = aoi.chipFeatures * aoi.chipFeatures;  // number of features that can fit in chip
	
	this.height = lat.dim;  // [m]
	this.width = lon.dim;	// [m]
	this.rows = lat.pixels;
	this.cols = lon.pixels;
	this.made = new Date(); 
				
	var 
		TL = this.TL = new POS(lat.val+lat.del, lon.val),  // {x:lat, y:lon} [rads]
		BL = this.BL = new POS(lat.val, lon.val),
		TR = this.TR = new POS(lat.val+lat.del, lon.val+lon.del),
		BR = this.BR = new POS(lat.val, lon.val+lon.del);
		
	//Log("chip", {lat: lat,lon: lon});
	
	var 
		TLd = TL.map(c), // [lat,lon] rads --> [lat,lon] degs
		BLd = BL.map(c),
		TRd = TR.map(c), 
		BRd = BR.map(c),
		ring = [TLd, BLd, BRd, TRd, TLd];
		
	this.bbox = toBBox( ring ); // [TLd[0], TLd[1], BRd[0], BRd[1]];   // [min lon,lat, max lon,lat]  degs
	this.lat = TLd[0]; 	// [degs]
	this.lon = TLd[1];  // [degs]
	this.ring = ring;

	if (this.r)  // curved earth model
		if ( lon.val < lon.max ) {  // advance lon
			lon.val += lon.del * (1-lon.ol);
			lon.idx++;
		}

		else { // reset lon and advance lat
			lon.val = lon.min;
			lon.idx = 0;
			lat.val += lat.del * (1-lat.ol);  // + fixed to *
			//lat.del = acos(1 - aoi.du/pow(cos(lat.val),2));
			lat.del = acos(1 - aoi.du / cos(lat.val) ** 2);
			lat.idx++;
		}

	else // flat earth model
		if ( lon.val < lon.max ) {  // advance lon
			lon.val += lon.del * (1-lon.ol);
			lon.idx++;
		}

		else { // reset lon and advance lat
			lon.val = lon.min;
			lon.idx = 0;
			lat.val += lat.del * (1-lat.ol);
			lat.idx++;
		}			
	
}

function ROC(f,obs) {
	this.f = f/100;  // forecasting level
	this.Npos = round(obs*f/100);		// number of positives in place
	this.Nobs = obs;  	// number of observations
	this.Nyes = 0; 		// number of positive observations
	this.Nno = 0;		// number of negative observations
	this.FPR = 0; 		// current false poisitve rate
	this.TPR = 0; 		// current true positive rate
	this.qual = 0; 		// roc quality (e.g. area under roc)
}

[
	function forecast(f,aoicase,model,obs,cb) {
		var chip = this;
		
		Trace(`FORECASTING ${aoicase} WITH ${chip.fileID} USING ${model} AT ${f}%`);
		
		var fchip = Copy(chip,{});
		
		fchip.ID = "forecasts/"+f+"_"+chip.fileID;
		
		/*
		if (thread = CHIP.sqlThread) // save roc
			thread( function (sql) {
				sql.query(  
					"REPLACE INTO rocs SET ?,address=geofromtext(?)", 
						[roc, chip.address], function (err,rec) {
							chip.rocID = rec.insertId;
							cb(roc);
				});
			});
					
		else
			cb(roc);
		*/
		
		cb( new ROC(f,obs) );
	},

	function runForecast(aoicase,cb) {
		var
			chip = this,
			Npixels = chip.gfs, //chip.aoi.gfs,  chip.Npixels ??
			sites = chip.sites, //chip.aoi.sites,
			tip = { width: 64, height: 64};

		if (false)
			makeJPG({
				LAYER: "", //chip.aoi.layerID,
				OUT: CHIP.paths.tips + chip.cache.ID + ".jpg",
				RETRY: chip.cache.ID+"",
				W: tip.width,
				H: tip.height,
				TL: chip.TL,
				BR: chip.BR
			});

		chip.makeImage( function (bchip) {
			Trace(`FORECAST ${bchip.job}`);
			bchip.forecast(0, function (roc) { // always run at f=0=1-FAR-1-HR level
				cb(bchip); // run detector against this chip
				
				if ( model = CHIP.models.debug )  {  // CHIP.models[bchip.cache.forecast] 
					Trace(`FORECASTING ${bchip.job} USING ${model.name}`);
					
					model.levels.each( function (n,f) {
						var fchip = chipAOI.clone(bchip); // initialize forecasting chip to background chip
						
						fchip.forecast(f, function (roc) { // run forecast at level f
							embedPositives(
								bchip.job,  		// name of background jpg 
								fchip.job,			// name of forecasting jpi containing embedded jpgs
								roc.Npos, 			// number of chips to embed
								model.srcs,			// candidate sources to embed
								model.scales.clone().scale(Npixels), // candidate embed scales
								model.flips, 		// candidate embed flips
								model.rots, 			// candidate embed rotations
								sites, 					// candidate embed sites
								function () {		// run detector against chip
									cb(fchip); 	
								}
							);
						});
					});
				}
			});
		});
	}
].Extend(chipAOI);

function toPolygon(ring) {  // [ [lat,lon], ... ] degs --> POLYGON(( lat lon, ... )) degs
	return 'POLYGON((' + [  
		ring[0].join(" "),
		ring[1].join(" "),
		ring[2].join(" "),
		ring[3].join(" "),
		ring[0].join(" ") ].join(",") +'))' ;
}

function toPoint( u ) {  // [lat,lon] degs --> POINT(lat,lon) degs
	return 	`POINT(${u[0]} ${u[1]})`;
}

function toBBox(ring) {  // [ [lat,lon], ...] degs --> [TL.lon, TL.lat, BR.lon, BR.lat] degs
	var 
		TL = ring[0],
		BR = ring[2],
		bbox = [TL[1], TL[0], BR[1], BR[0]];
	
	return bbox.join(",");
}
	
function toRing(poly) {  // [[ {x,y}, ...]] degs --> [ [lat,lon], ...] degs 
	var rtn = [];
	poly[0].forEach( function (pt) {
		rtn.push( [pt.x, pt.y] );
	});
	return rtn;
}

[
	function pos(c) { 
		return  new POS(this[1]/c, this[0]/c); 
	},
	
	function samp() {
		return this[ floor( random() * this.length ) ];
	},

	function scale(a) {
		for (var n=0, N=this.length; n<N; n++) this[n] = this[n] * a;
	}
].Extend(Array);
	
[
	function getJulian() {
		return Math.ceil((this / 86400000) - (this.getTimezoneOffset()/1440) + 2440587.5);
	}
].Extend(Date);
	
function util(sql, runopt, input, rots, pads, flips) {  //< supports GX unit testing
	var 
		plop=0, plops=flips.length * rots.length * pads.length,
		now = new Date();

	IMP.open("backgrd.jpg", "jpg", function (err,bg) {

		Trace(err || "read background");

		var
			bgbatch = bg.batch(),
			bgwidth = bg.width(),
			bgheight = bg.height();

		FS.readFile(input, "utf8", function (err,files) {
			var files = files.split("\n");

			files.length--;
			var
				plop_count = files.length * plops,
				plop_saves = [];

			files.each( function (n,file) {
				var 
					parts = file.split("/"),
					name = parts[parts.length-1];

				IMP.open(file, "jpg", function (err,opened) {

					Trace(err || "read "+file);

					switch (runopt) {
						case 6: 
							IMP.open("jpgs/pos-0.jpg", function (err,pos) {
								if (true)
									bg.batch().paste(0,0,pos).paste(50,50,pos).writeFile("jump.jpg", "jpg", {}, function () {} );

								else
									bg.paste(0,0,pos, function (err) {
										Trace({paste: err});
										bg.writeFile("jump.jpg", "jpg", {} , function () {});
									});
							});

							break;

						case "pgmtojpg":
							var out = "jpgs/"+name.replace(".pgm","jpg");
							CP.exec(`convert ${file} ${out}`, ENV);
							break;

						case 4:
							Trace(file+" 1 0 0 100 40\n");
							break;

						case 5:
							for (var n=0, m=0; m<plops; m++)
								opened.clone( function (err,cloned) {
									var posbatch = cloned.batch();

									posbatch.rotate( (random() - 0.5)/0.5*45, "black" );
									posbatch.writeFile("rots/"+n+".jpg", "jpg", {}, function () {});
									n++;
								});
							break;

						case "makesamples":

							border(opened, pads, function (padded) {
								rotate(padded, rots, function (rotated) {
									bg.clone( function (err,cloned) {
										cloned.paste(0,0,rotated, function (err,pasted) {
											var save = "samples/"+name;
											plop_save.push(save+[1,0,0,pasted.width(),pasted.height()].join(" "));
											pasted.writeFile(save, "jpg", {}, function (err) {
												Trace(err);
											});

											if (++plop == plop_count)
												FS.writeFile("samples.txt", plop_saves.join("\n"));
										});
									});
								});
							});

							break;

						case "maketest":

							resize( opened, 0, function (scaled) {
							flip( scaled, flips, function (flipped) {
							rotate( flipped, rots, function (rotated) {
								bgbatch.paste( 
									floor( random() * (bgwidth - rotated.width()) ),
									floor( random() * (bgheight - rotated.heigth()) ),
									rotated);

								if (++plop == plop_count)
									bgbatch.writeFile(input+"_test.jpg", "jpg", {}, function (err) {
										Trace(err || "saved");
									});

							});
							});
							});
							break;

						case "dbprime":
							sql.query("INSERT INTO app.proofs SET ?", {
								top: 0,
								left: 0,
								width: opened.width(),
								height: opened.height(),
								label: inpt,
								name: name,
								made: now
							}, function (err) {
								Trace(err);
							});
							break;

						case 2:
							var tests = [];
							for (var m=0; m<plops; m++) 
								tests.push( `opencv_createsamples -file ${file} -bg negatives.txt -info test_${tests.length}.info -maxxangle 0 -maxyangle -maxzangle 3.14` );

							tests.sync(0, function (n) {
								Trace(tests[n]);

								FS.readFile("test+"+n+".info", "utf8", function (err,filename) {

									var 
										parts = filename.split(" "),
										filename = parts[0];

									CP.exec( `cp ${filename} test_${n}_${filename}` );

								});
							});
							break;
					}

				});
			});
		});

	});
}

//=================================== unit testing

switch (process.argv[2]) { //<unit tests and db config
	case "G?":
	case "?":
		Trace("unit test with 'node geohack.js [G$ || G1 || G2 || ...]'");
		break;
		
	case "G$":
		Debug(chipAOI);
		break;
		
	case "G1":
		var CHIP = require("../geohack");

		var TOTEM = require("../totem").config({
			"byTable.": {
				chip: CHIP.chippers,

				wfs: function (req,res) {
					res("here i go again");

					TOTEM.fetchers.http(ENV.WFS_TEST, function (data) {
						console.log(data);
					});

				}

			},				

			mysql: {
				host: ENV.MYSQL_HOST,
				user: ENV.MYSQL_USER,
				pass: ENV.MYSQL_PASS
			}
		}, function (err) {
			Trace( err || "Go ahead and test my default /chip and /wfs endpoints", {
				my_readers: TOTEM.byTable
			});
		});

		CHIP.config({
			thread: TOTEM.thread
		});
		break;	

	case "G2":  // db setups

		var TOTEM = require("../totem").config({
			"byTable.": {
				chip: CHIP.chippers,

				wfs: function (req,res) {
					res("here i go again");

					TOTEM.fetchers.http(ENV.WFS_TEST, function (data) {
						console.log(data);
					});

				}

			},				

			mysql: {
				host: ENV.MYSQL_HOST,
				user: ENV.MYSQL_USER,
				pass: ENV.MYSQL_PASS
			}
		}, function (err) {
			Trace( err || "Go ahead and test my default /chip and /wfs endpoints", {
				my_readers: TOTEM.byTable
			});
		});
		
		TOTEM.thread( function (sql) {
			switch ( process.argv[3] ) {
				case "--util":
					util(sql, args[3], args[4], [], [], []);
					break;

				case "--suncheck":
					Trace({
						Solar: new SOLAR(40771, 0.1/24, 3, 55.56, 38.14)
					});
					break;

				case "--dbprime":
					util(sql,"dbprime","notcat",[0],[0],[""]);
					break;

				case "--cars":
					util(sql,"maketest","cars",[0],[0],["","y","y","xy"]);
					util(sql,"maketest","cars",[45],[0],[""]);
					break;

				case "--digits":
					process.chdir(ENV.DIGITS);
					util(sql,"maketest","revbg.txt",[0],[0],[""]);
					break;

				case "--rings":
					var 
						c = 180/Math.PI,
						ring = [
							[70.0899, 33.9108], // TL lon,lat [degs]
							[70.0988, 33.9018], // TR
							[70.0988, 33.9105], // BR
							[70.0899, 33.9105] // BL
						];

					console.log({deg: ring[0], rad: ring[0].pos(c), degrtn: ring[0].pos(c).map(c)});

				default:
					Trace("IGNORING UTIL SWITCH "+args[2]);
			}
		});
		break;
	
}
