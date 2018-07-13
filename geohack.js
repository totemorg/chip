// UNCLASSIFIED

/**
 * @class GEOHACK
 * @requires fs
 * @requires child_process
 * @requires stream
 * @requires crypt
 * @requires enum
 * @requires glwip
 */
var   
	// globals
	ENV = process.env,
	
	// nodejs
	FS = require("fs"), 
	CP = require("child_process"),
	STREAM = require("stream"),
	CRYPTO = require("crypto"),

	// totem
	LWIP = require('glwip');

const { Copy,Each,Log } = require("enum");

var HACK = module.exports = {
	
	aoi: null, 			//< current aoi being processed
	limit: 1e99, 		//< max numbers of chips to pull over any aoi

	make: { 
		chip: function makeChip( fetch, parms, cb ) {
			var chip = parms;

			FS.stat(chip.path, function (err) { // check if chip in file cache
				if (err)  // not in cache so prime it
					fetch( HACK.paths.images.tag("?", parms )+` >> ${chip.path}`, null, null, function (rtn) {
						Log("fetch chip", parms.path, rtn);
						cb( rtn ? chip : null );
					});

				else // in cache
					cb(chip);
			});
		},

		flux: function makeFlux( fetch, parms, cb) {
			var tod = parms.tod;
			cb( new SOLAR( tod.getJulian(), tod.getHours()/24, tod.getTimezoneOffset()/60, parms.lat, parms.lon) );
		},

		collects: function makeCollects( fetch, parms, cb) {
			fetch( HACK.paths.catalog.tag("?", parms), null, null, function (cat) {
				cb(cat);
			});
		}
	},				
	
	ringRadius: function (ring) {
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
	
	chipEvents: function ( sql, pipe, cb ) {  //< callback cb(meta) 
		
		function toQuery(q, def) {
			if ( q  )
				return (typeof q == "string") 
					? q.toQuery(sql, def)
					: Copy(q, def);
			
			else
				return def;
		}
		
		function chipJob( pipe ) {

			function chipFile( file ) { 
				
				function chipVoxels( aoi, voi, soi) {
					
					function getMeta( aoi, soi, file, voxel ) {

						var
							makeChip = HACK.make.chip,
							makeFlux = HACK.make.flux,
							makeCollects = HACK.make.collects,
							limit = pipe.limit || 1000,
							offset = pipe.offset || 0,
							order = pipe.order || "t",
							fields = pipe.fields || "*";

						sql.cache({  // determine sensor collects at chip under this voxel
							key: {
								Name1: "collects", 
								Index1: voxel.chipID,
								Name1: JSON.stringify(soi),
								t: 0
							},
							parms: Copy(soi, { 
								ring: aoi
							}),
							default: [],
							make: makeCollects
						}, function (collects) {

							//Log(voxel.Ring, collects);
							var
								Ring = toRing( voxel.Ring );

							sql.cache({
								key: {
									Name1: "chip", 
									x1: voxel.lon, 
									x2: voxel.lat,
									t: 0
								},
								parms: { 
									path: `./public/images/chips/${voxel.chipID}.jpeg`,
									bbox: toBBox( Ring ),
									ring: toPolygon( Ring ),
									lat: voxel.lat,
									lon: voxel.lon
								},
								default: {
									path: (collects[0] || {url: "./shares/spoof.jpg"}).url									
								},
								make: makeChip
							}, function (chip) {

								sql.cache({  // get solar flux information at this chip
									key: {
										Name1: "flux", 
										x1: voxel.lon, 
										x2: voxel.lat,
										t: 0
									},
									parms: { 
										lat: voxel.lat,
										lon: voxel.lon,
										tod: new Date()
									},
									default: null,
									make: makeFlux
								}, function (flux) {

									if ( pipe.ag )
										sql.forFirst( // get stats on this file-voxel pair
											"REG",
											"SELECT * FROM app.stats WHERE least(?)", 
											[ {fileID: file.ID, voxelID: voxel.ID} ], function (stats) {

											cb({
												File: file,
												Voxel: voxel,
												Events: sql.format(
														`SELECT ${fields} FROM app.events WHERE ? AND MBRcontains(geomfromtext(?),Point(x,y)) ORDER BY ${order} LIMIT ? OFFSET ?`,
														[{fileID: file.ID}, toPolygon(aoi), limit, offset]  ),
												Flux: flux,
												Stats: stats,
												Collects: collects,
												Chip: chip
											});
										});

									else
										sql.forEach( // get each voxel above this chip
											"REG",
											"SELECT * FROM app.voxels WHERE ?",
											[ {chipID: voxel.chipID} ], function (voxel) {

												sql.forFirst( // get stats on this file-voxel pair
													"REG",
													"SELECT * FROM app.stats WHERE least(?)", 
													[ {fileID: file.ID, voxelID: voxel.ID} ], function (stats) {

													cb({
														File: file,
														Voxel: voxel,
														Events: sql.format(	
																`SELECT ${fields} FROM app.events WHERE least(?,1) ORDER BY ${order} LIMIT ? OFFSET ?`,
																[{voxelID: voxel.ID, fileID: file.ID}, limit, offset]  ), 
														Flux: flux,
														Stats: stats,
														Collects: collects,
														Chip: chip
													});

													/*if (hypo) {  // test chipID if over ground truth site then start a ROC workflow
													} */
												}); 
											});	

								});
							});

						});
					}
			
					Log("chip", {aoi: aoi, voi: voi, soi: soi} );
					
					if (pipe.ag) 
						sql.forEach( get.msg, get.surfaceVoxels, [ toPolygon(aoi), {Class:voi.Class, Alt:0, Ag:1} ], (voxel) => {

							sql.forAll( get.msg, get.surfaceVoxels, [ toPolygon(aoi), voi ], (voxels) => {
							
								var 
									states = file.stateSymbols = [],
									keys = file.stateKeys = {index:"index", state:"voxelID"};

								voxels.forEach( (voxel) => {
									states.push(voxel.ID);
								});

								Log("chip states", voxel.ID, states);
								//cb( null, aoi, soi, file, voxel );
								getMeta( aoi, soi, file, voxel );
								
							});

						});
						
					else
					if (aoi.length)		// pull all surface voxels falling in specified aoi and of specified class
						sql.forEach( get.msg, get.surfaceVoxels, [ toPolygon(aoi), voi ], (voxel) => {							
							getMeta( aoi, soi, file, voxel );
						});
					
					else
					if (file.Ring)		// pull all surface voxels over specified file
						sql.forEach( get.msg, get.surfaceVoxels, [ toPolygon(toRing(file.Ring)), voi ], (voxel) => {
							getMeta( aoi, soi, file, voxel );
						});
					
					else
					if (file.ID)	// pull all voxels by event refs and stack them by chipID
						sql.query( get.voxelsByRef, {fileID: file.ID})
						.on("result", (ev) => {
							sql.forEach( get.msg, get.voxelsByID, {ID: ev.voxelID}, (voxel) => {
								getMeta( aoi, soi, file, voxel );
							});
						});
					
					else
						sql.forEach( get.msg, get.dummyVoxels, [ ], (voxel) => {
							getMeta( aoi, soi, file, voxel );
						});
					
				}
				
				if (aoi.Name)  // pull all events inside aoi by name
					sql.forEach( get.msg, get.rings, {Name:aoi.Name}, function (rec) {
						chipVoxels( JSON.parse(rec.Ring) , voi, soi );
					});

				else   // pull all events inside aoi
					chipVoxels( aoi, voi, soi );
			}
			
			var 
				group = pipe.group,
				soi = toQuery(pipe.soi, {Name: ""} ),
				aoi = toQuery(pipe.aoi, {Name: ""} ),
				voi = toQuery(pipe.voi, {Alt:0, Class:0, Ag:0}),
				src = pipe.file || pipe.source || "",
				get = {
					rings: "SELECT Ring FROM app.aois WHERE ?",
					//chips: `SELECT ${group} FROM app.events GROUP BY ${group} `,
					//voxels: "SELECT * FROM app.voxels WHERE ?", 
					voxelsByRef: "SELECT voxelID FROM app.events WHERE ? GROUP BY voxelID",
					voxelsByID: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE ? GROUP BY chipID",
					surfaceVoxels: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE MBRcontains(GeomFromText(?), voxels.Ring) AND least(?,1) GROUP BY chipID ORDER BY ID",
					dummyVoxels: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE Ring IS null GROUP BY chipID ORDER BY ID",
					//agVoxels: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE MBRcontains(GeomFromText(?), voxels.Ring) AND least(?,1) GROUP BY chipID",
					//chips: "SELECT ID,lon,lat,alt,chipID,Ring FROM app.voxels WHERE MBRcontains(GeomFromText(?), voxels.Ring) AND least(?,1) ORDER BY ID",
					files: "SELECT * FROM app.files WHERE least(?,1)",
					msg: `REG ${src}`
				};

			switch ( src.constructor ) {
				case String: 
					sql.forEach( get.msg, get.files, src.toQuery(sql,{}), function (file) {  // regulate requested file(s)

						["stateKeys", "stateSymbols"].parseJSON(file);
						Log( "file", file );
						
						if (file.Archived) 
							CP.exec("", function () {
								Trace("RESTORING "+file.Name);
								sql.query("UPDATE app.files SET Archived=false WHERE ?", {ID: file.ID});
								chipFile(file);
							});

						else
							chipFile(file);

					});				
					break;
					
				case Array:  // src contains event list
					cb({
						File: {ID: 0, Name:""},
						Events: src
					});
					break;
					
				case Object:  // src contains single event
					cb({
						File: {ID: 0, Name:""},
						Events: [src]
					});
					break;
			}

		}

		switch ( pipe.constructor ) {
			case String:
				if ( pipe.charAt(0) == "/" )
					chipJob({ file: pipe });
					
				else
				if ( pipe.indexOf(".") >= 0 )
					chipJob({ file: pipe });
				
				else
					sql.forEach( "REG", "SELECT pipe FROM app.pipes WHERE ?", {Name:pipe}, function (rec) {
						try {
							chipJob( JSON.parse(rec.pipe) );
						}
						catch (err) {
						}
					});
				break;
			
			case Array:
				chipJob({
					file: pipe
				});
				break
			
			case Object:
				chipJob( pipe );
				break;
		}
	},
	
	ingestCache: function (sql, fileID, cb) {  // ingest the evcache into the events with callback cb(aoi)
		
		sql.forAll(  // ingest evcache into events history by determining which voxel they fall within
			"INGEST",
			fileID 
				// voxelize the events
				? "INSERT INTO app.events SELECT evcache.*,voxels.ID AS voxelID FROM app.evcache " 
						+ "LEFT JOIN app.voxels ON least( " + [
								"MBRcontains(voxels.Ring,point(evcache.x,evcache.y))" ,
								"evcache.z BETWEEN voxels.alt AND voxels.alt+voxels.height",
								"voxels.class = evcache.class"
							].join(", ") + ") WHERE ? HAVING voxelID"

				// bypass voxelization
				: "INSERT INTO app.events SELECT *, 0 AS voxelID FROM app.evcache WHERE ?" ,
			
			{"evcache.fileID":fileID},
			
			function (ingest) {
				
			sql.forFirst(
				"INGEST",
				
				"SELECT "
				+ "? AS Voxelized, "
				+ "min(x) AS xMin, max(x) AS xMax, "		// lat [degs]
				+ "min(y) AS yMin, max(y) AS yMax, "		// lon [degs]
				+ "min(z) AS zMin, max(z) AS zMax, "		// alt [km]
				+ "floor(max(s)) AS Steps, "		// ms steps
				+ "max(`state`)+1 AS States, "
				+ "max(`index`)+1 AS Actors, "
				+ "count(id) AS Samples "
				+ "FROM app.evcache WHERE ?", 
				
				[ ingest.affectedRows, {fileID:fileID} ],	cb);
				
		});
	},

	ingestPipe: function (sql, filter, fileID, src, cb) {  // pipe src event stream with callback cb(aoi) when finished.
		sql.query("DELETE FROM app.evcache WHERE ?", {fileID: fileID});

		sql.query("SELECT startTime FROM app.files WHERE ? LIMIT 1", {ID: fileID}, function (err, ref) {
			
			var 
				ingested = 0,
				refTime = ref[0].startTime,
				sink = new STREAM.Writable({
					objectMode: true,
					write: function (rec,en,cb) {

						function cache(ev) {

							ingested++;
							
							sql.query(
								"INSERT INTO app.evcache SET ?", [{
									x: ev.x || 0,		// lat [degs]
									y: ev.y || 0,		// lon [degs]
									z: ev.z || 0,		// alt [km]
									t: ev.t,		// sample time [ms]
									s: ev.s || (ev.t - refTime), 		// relative steps [ms]
									class: ev.class || 0, // class type
									index: ev.index || 0,		// unqiue id 
									state: ev.state || 0,		// current state 
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
			.on("finish", function () {

				sql.endBulk();

				//Trace(`INGEST ${ingested} EVENTS FROM FILE${fileID}`);

				if ( ingested )  // callback if there were ingested events
					HACK.ingestCache(sql, fileID, function (aoi) {
						//Log("ingest cb", cb);
						cb(aoi);

						var
							TL = [aoi.yMax, aoi.xMin],   // [lon,lat] degs
							TR = [aoi.yMax, aoi.xMax],
							BL = [aoi.yMin, aoi.xMin],
							BR = [aoi.yMin, aoi.xMax], 
							Ring = [ TL, TR, BR, BL, TL ];

						sql.forAll(  // update file with aoi info
							"INGEST",
							"UPDATE app.files SET ?, Samples=Samples+?, Rejects=Rejects+?, Relevance=1-Rejects/Samples WHERE ?", [{ 
								States: aoi.States,
								Steps: aoi.Steps,
								Actors: aoi.Actors,
								Graded: false,
								Pruned: false,
								Archived: false
							},
							aoi.Voxelized,
							aoi.Samples - aoi.Voxelized,
							{ID: fileID} 
						]);

					});

			})
			.on("error", function (err) {
				sql.endBulk();
				Log("INGEST FAILED", err);
			});
		
			src.pipe(sink);  // start the ingest
		});
	},
	
	ingestList: function (sql, evs, fileID, cb) { // ingest events list to internal fileID with callback cb(aoi) when finished.
	/**
	@member HACK
	@private
	@method ingestList
	@param {Object} sql connector
	@param {Array} evs events [ ev, ... ] to ingest
	@param {Number} fileID of internal event store (0 to bypass voxelization)	
	@param {Function} cb Response callback( ingested aoi info )
	Ingest an event list into the internal events file.
	*/
		//Trace(`INGEST ${evs.length} EVENTS ON ${fileID}`);
		
		var 
			n = 0, N = evs.length,
			src = new STREAM.Readable({  // source stream for event ingest
				objectMode: true,
				read: function () {  // return null if there are no more events
					this.push( evs[n++] || null );
				}
			});
		
		HACK.ingestPipe(sql, null, fileID, src, cb);
	},
	
	ingestFile: function (sql, evsPath, fileID, cb) {  // ingest events in evsPath to internal fileID with callback cb(aoi).
	/**
	@member HACK
	@private
	@method ingestFile
	@param {Object} sql connector
	@param {String} path to events file containing JSON or csv info
	@param {Number} fileID of internal event store (0 to bypass voxelization)
	@param {Function} cb Response callbatck( ingested aoi info )
	Ingest events in a file to the internal events file.
	*/
		function filter(buf, cb) {
			buf.split("\n").each( function (n,rec) {
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
		
		HACK.ingestPipe(sql, filter, fileID, src, cb);
	},
		
	ingestService: function (url, fetch, chan, cb) {  // ingest events from service channel
		
		var
			tmin = chan.tmin,
			tmax = chan.tmax;
		
		HACK.thread( function (sql) {	
			fetch( url.tag("?", {tmin:tmin,tmax:tmax}), null, null, function (evs) {
				var 
					n = 0,
					str = HACK.ingestStream( sql, "guest", function () {
						var ev = evs[n++];
						this.push( ev ? JSON.stringify([ev.x,ev.y,ev.z,ev.n]) : null );
					}).pipe( str );
			});
		});
	},	
			
	thread: () => { Trace("sql thread not configured"); },  //< sql threader
	
	errors: {
		nowfs: new Error("chipping cataloge service failed"),
		nowms: new Error("chipping service failed to provide a wms url"),
		noStepper: new Error("engine does not exist, is not enabled, or lost stepper")
	},
	
	getImage: function (chip,aoicase,cb) { // Load chip with Npixels then callback(cb).  Auto-forecasting when needed.
		
		function paste(img, src, left, top, cb) {
			if ( left+src.width() > img.width() )
				left = img.width() - src.width();
			
			if ( top+src.height() > img.height() )
				top = img.height() - src.height();
			
			if (cb)
				img.paste(left, top, src, function (erm,img) {
					img.clone(function (err,img) {
						cb(img);
					});
				});
			else
				img.paste(left, top, src);
		}
		
		function rotate(img, angle, cb) {
			var bgcolor = [255,255,255,0];
			if (cb)
				img.rotate(angle, bgcolor, function (err,img) {
					img.clone(function (err,img) {
						cb(img);
					});
				});
			else
				img.rotate(angle, bgcolor);
		}
		
		function border(img, pad, cb) {
			if (pad.constructor == Array) 
				pad.each(function (n,val) {
					img.clone(function (err,image) {
						border(image, val, cb);
					});
				});
			
			else
			if (pad)
				img.border(pad, [0,0,0,0], function (err,image) {
					cb(image);
				});
			
			else
				cb(img);
		}
		
		function flip(img, axis, cb) {
			if (axis)
				if (cb)
					img.flip(axis, function (err,img) {
						img.close(function (err,img) {
							cb(img);
						});
					});
			else
			if (cb)
				cb(img);
		}
		
		function resize(img, width, height, cb) {
			if (cb) 
				img.resize(width, height, function (err, img) {
					img.clone(function (err,img) {
						cb(img);
					});
				});
			else
				img.resize(width, height);
		}
		
		function open(src, args, cb) {
			LWIP.open(src, "jpg", function (err,img) {
				if (err)
					console.log(err);
				else
				if (cb)
					cb(img.batch(), Copy({open:{width: img.width(), height: img.height()}}, args));
			});
		}
		
		// create a forcasting jpg fcname by dropping random source jpgs at random scales, flips and
		// rotations into a background jpg bgname.
		function embedPositives(bgname, fcname, draws, cb) { 
			var drops  = 0; for (var n in draws) drops++;
			
			if (drops) 
				open(ENV.HACK+bgname, function (bg, args) {
					
					var 
						bgwidth = args.open.width,
						bgheight = args.open.height;
					
					for (var n in draws) 
						open(ENV.PROOFS+draws[n].src, draws[n], function (img, drop) {
							resize( img, drop.width, drop.height);
							flip( img, drop.flip);
							rotate( img, drop.rot);

							img.exec( function (err,img) {

								if (drop.left+img.width() > bgwidth )
									drop.left = img.wdith() - img.width();

								if (drop.top+img.height() > bgheight )
									drop.top = img.height() - img.heigth();

								bg.paste(drop.left, drop.top, img);

								if (! --drops)
										bg.exec( function (err,bgimg) {
											bgimg.writeFile(ENV.HACK+"forecast_"+fcname, "jpg", {}, function (err) {
												if (cb) cb(fcname);
											});
										});
							});
						});
				});
		
			else
				cb(bgname);
		}
			
		function runForecast(chip,aoicase,cb) {
			if (model = HACK.models.none) {  // use forecasting model
				var 
					aoi = chip.aoi,
					Npixels = aoi.chipPixels,
					sites = Npixels * Npixels,   // Nfeatures ^ 2 ??
					gfs = aoi.gfs,
					name = aoicase.Name,
					obs = aoicase.oevents.length,  // max observation sites say 64 ??
					bgname = chip.fileID,
					emeds = 0;
				
				model.levels.each( function (n,f) { // n'th forecast at level f
					chip.forecast(f, name, model.name, obs, function (roc,fchip) { // forecast at level f
						var
							Nnew = roc.Npos - embeds,
							draws = {},
							srcs = models.srcs,
							flips = models.flips,
							rots = model.rots,
							aspect = 40/100,
							scales = model.scales;
						
						for (var n=0; n<Nnew; ) {
							if (! draws[ i = round(random() * sites) ] )
								draws[i] = { // draw a random embed
									idx: n++,
									height: round(gfs*scale.sample()*aspect),
									width: gfs*scale.sample(),
									src: srcs.sample(),
									flip: flips.sample(),
									rot: rots.sample(),
									top: round(i / Npixels),
									left: i % Npixels
								};
							
							else
								console.log(["skip",n,i]);
						}
						
						embedPositives(
							bgname, // name of background image to embed forecasting jpgs
							fchip.ID, 	// name of forecast jpg
							draws, 	// random draw for embeds
							function (name) {  // run detector against forecasting chip
								fchip.ID = name;
								cb(fchip);		
						});
						
						embeds += Nnew;
						bgname = fchip.ID;
					});
				});
			}
			
			else  // no forecasting model
				cb(chip);
		}
		
		var 
			fetchImage = HACK.fetchImage,
			impath = fetchImage.wgetout = HACK.paths.images + chip.fileID;
		
		FS.stat(impath, function (err) { // check if chip in cache
			if (err)  // not in cache
				fetchImage( {bbox:chip.bbox.join(",")}, function (rtn) {
					//console.log({fetchimage: rtn});

					Trace("FETCH "+chip.fileID);
					if ( !err) runForecast(chip, aoicase, cb);
				});
			
			else { 	// in cache
				Trace("CACHE "+chip.fileID);
				runForecast(chip, aoicase, cb);
			}
		});
		
	},
	
	/*
	tagCollect: function (chip, cb) {  // process all collects associated with requested chip with callback cb(chip) 
		Each(HACK.collects, function (n,collect) {  // tag chip with collect info
			cb( Copy(collect, chip) );
		});
	}, */
	
	paths: {
		images: ENV.SRV_TOTEM+"/shares/spoof.jpg", //ENV.WMS_TOTEM,
		catalog: ENV.WFS_TOTEM,
		tips: ENV.TIPS
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
		
		if (opts) Copy(opts, HACK, ".");
		
		/*
		if ( streamingWindow = HACK.streamingWindow)
			HACK.ingestStreams(streamingWindow, function (twindow,status,sql) {
				console.log(twindow,status);
			}); */			

		if (cb) cb(null);
		return HACK;
	},
	
	detectAOI: function (sql, aoicase) {
		
		HACK.chipAOI(sql, aoicase, function (chip) {

			Log("detecting chip", chip.bbox);

		});
	},
	
	voxelizeAOI: function (sql, aoicase) {
		
		var now = new Date();
		
		const {sqrt} = Math;
		
		HACK.chipAOI(sql, aoicase, function (chip) {

			Log("make voxels above", chip.ID);

			for (var alt=0, n=0; n<aoicase.voxelCount; n++,alt+=aoicase.voxelDepth)  { // define voxels above this chip
				sql.query(
					//"INSERT INTO app.voxels SET ?, Ring=GeomFromText(?), Anchor=GeomFromText(?)", [{
					"INSERT INTO app.voxels SET ?, Ring=GeomFromText(?)", [{
					class: aoicase.Name,
					lon: chip.lon,
					lat: chip.lat,
					alt: alt,
					length: chip.width,
					width: chip.height,
					height: aoicase.voxelDepth,
					chipID: chip.ID,
					radius: sqrt(chip.width**2 + chip.height**2),
					added: now,
					minSNR: 0
				}, 
					chip.ring, 
					//chip.anchor
				] );

				//if (!alt) Log(chip.ring);
				//if (!alt) Log(q);
			}

		});		
	},
	
	chipAOI: function (sql, aoicase, cb) {
		var
			ring = aoicase.ring, // [ [lat, lon], ...] degs
			chipFeatures = aoicase.chipFeatures, // [ features along edge ]
			chipPixels = aoicase.chipPixels, // [pixels]
			featureDim = aoicase.featureLength, // [m]
			overlap = aoicase.featureOverlap, // [features]
			chipDim = featureDim * chipFeatures,  // [m]
			earthRadius = aoicase.radius,  // [km]  6147=earth 0=flat
			aoi = new AOI( ring, chipFeatures, chipPixels, chipDim, overlap, earthRadius);

		Log("voxelize", aoicase);
		//sql.beginBulk();   // speeds up voxel inserts but chipID will be null
		
		aoi.chipArea(aoicase, function (chip) {  //< enumerate chips over this aoi
			
			if (chip)  // still chips in this aoi
				sql.cache({  // get chip info or make it if not in the cache
					key: {  		// key chips in the cache like this
						Name1: "chip", 
						x1: chip.pos.lat.toFixed(4), 
						x2: chip.pos.lon.toFixed(4),
						t: 0
					},
					parms: chip,	// parms to make is just the chip itself
					default: null,  // discard uncached chips from this flow
					make: function makeChip(fetch, parms, cb) {  
						cb(parms);  // dont fetch chip as aoi only voxelizing
					}
				}, cb );
			
			else { // no more chips in this aoi
				//sql.endBulk();
			}
			
		});	
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

/*==================================================================
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

Array.prototype.pos = function (c) { return  new POS(this[1]/c, this[0]/c); }

POS.prototype = {
	map: function (c) { return [this.x*c, this.y*c]; },
	add: function (u) { this.x += u.x; this.y += u.y; return this; },
	sub: function (u) { this.x -= u.x; this.y -= u.y; return this; },
	scale: function (a) { this.x *= a; this.y *= a; return this; },
	set: function (u) { this.x *= u.x; this.y *= u.y; return this; },
	copy: function () { return new POS(this.x,this.y); }
}

/*===================================================
AOI interface
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

AOI.prototype = {	
	getChip: function (aoicase,cb) { // callback cb(chip) with next chip in this chipping process
		var
			aoi = this,
			lat = this.lat,
			lon = this.lon,
			withinAOI = aoi.chips++ < HACK.limit && lat.idx <= lat.steps; //lat.val <= lat.max;
		
		//Log(aoi.chips, lat.idx, lon.idx);
		
		if ( withinAOI )  // process if max chips not reached
			cb( new CHIP(aoi) );
		
		return withinAOI;	
	},

	chipArea: function (aoicase,cb) {  // start regulated chipping 
		var aoi = this;
		
		aoi.chips = 0;  // reset chip counter
		
		while ( aoi.getChip( aoicase, cb) );
		cb( null );  // mark process done
	}
};

function CHIP(aoi) {
	var
		cos = Math.cos,
		acos = Math.acos,	
		eps = {pos: 0.00001, scale:0.01},
		lat = aoi.lat,  // [rads]
		lon = aoi.lon,  // [rads]
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
	this.ring = toPolygon( ring );

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

CHIP.prototype = {
	forecast: function (f,aoicase,model,obs,cb) {
		var chip = this;
		
		Trace(`FORECASTING ${aoicase} WITH ${chip.fileID} USING ${model} AT ${f}%`);
		
		var fchip = Copy(chip,{});
		
		fchip.ID = "forecasts/"+f+"_"+chip.fileID;
		
		/*
		if (thread = HACK.thread) // save roc
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

	runForecast: function (aoicase,cb) {
		var
			chip = this,
			Npixels = chip.gfs, //chip.aoi.gfs,  chip.Npixels ??
			sites = chip.sites, //chip.aoi.sites,
			tip = { width: 64, height: 64};

		if (false)
			makeJPG({
				LAYER: "", //chip.aoi.layerID,
				OUT: ENV.TIPS + chip.cache.ID + ".jpg",
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
				
				if ( model = HACK.models.debug )  {  // HACK.models[bchip.cache.forecast] 
					Trace(`FORECASTING ${bchip.job} USING ${model.name}`);
					
					model.levels.each( function (n,f) {
						var fchip = CHIP.clone(bchip); // initialize forecasting chip to background chip
						
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
}

function Trace(msg,arg) {
	ENUM.trace("G>",msg,arg);
}

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
	function sample() {
		return this[ floor( random() * this.length ) ];
	},

	function scale(a) {
		for (var n=0, N=this.length; n<N; n++) this[n] = this[n] * a;
	}
].extend(Array);
	
[
	function getJulian() {
		return Math.ceil((this / 86400000) - (this.getTimezoneOffset()/1440) + 2440587.5);
	}
].extend(Date);
	
function util(sql, runopt, input, rots, pads, flips) {  //< supports GX unit testing
	var 
		plop=0, plops=flips.length * rots.length * pads.length,
		now = new Date();

	LWIP.open("backgrd.jpg", "jpg", function (err,bg) {

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

				LWIP.open(file, "jpg", function (err,opened) {

					Trace(err || "read "+file);

					switch (runopt) {
						case 6: 
							LWIP.open("jpgs/pos-0.jpg", function (err,pos) {
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

switch (process.argv[2]) { //<unit tests and db config
	case "G1":
		var HACK = require("../geohack");

		var TOTEM = require("../totem").config({
			"byTable.": {
				chip: HACK.chippers,

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

		HACK.config({
			thread: TOTEM.thread
		});
		break;	

	case "GX":  // db setups

		var TOTEM = require("../totem").config({
			"byTable.": {
				chip: HACK.chippers,

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
