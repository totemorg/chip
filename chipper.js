// UNCLASSIFIED

var
	ENV = process.env;  //< globals

var
	FS = require("fs"), //< nodejs
	CP = require("child_process"),
	CRYPTO = require("crypto");

var
	ENUM = require("enum").extend({  // forecasting support methods
		String: [
			function tagQuery(where) {
				if (where)
					if (where.constructor == String)
						return this + " AND " + where;
					else
						return this + " AND LEAST(?,1)";
				else
					return this + "";
			}
		],

		Array: [
			function sample() {
				return this[ floor( random() * this.length ) ];
			},
			
			function scale(a) {
				for (var n=0, N=this.length; n<N; n++) this[n] = this[n] * a;
			}
		]
	}),
	ENGINE = require("engine"),
	STREAM = require("stream"),
	LWIP = ENGINE.plugins.LWIP;

var 
	Copy = ENUM.copy,
	Each = ENUM.each,
	Log = console.log;

var CHIPPER = module.exports = {
	// set or optionally overridden by config()
	
	fetch: {  // default data fetching services
	},
	
	aoi: null, 			//< current aoi being processed
	limit: 1e99, 		//< max numbers of chips to pull over any aoi
	
	chipEvents: function ( req, ctx, cb ) {  // callback cb(job)
		
		var 
			sql = req.sql,
			pos = 0, 
			Job = ctx.Job,
			group = Job.group,
			where = Job.where || {},
			order = Job.order || "t",
			limit = Job.limit || 1000,
			file = Job.file,
			src = `${req.group}.events`, //"??.events LEFT JOIN ??.voxels ON events.voxelID = voxels.ID ",
			fields = "*",
			offset = Job.offset || 0, 
			get = {
				events: `SELECT ${fields} FROM ${src} WHERE least(?,1) ORDER BY ${order} LIMIT ? OFFSET ?`,
				chips: `SELECT ${group} FROM ${src} GROUP BY ${group} `,
				voxels: "SELECT * FROM app.voxels WHERE MBRcontains(ST_GeomFromText(?), Ring)", 
				files: "SELECT * FROM app.files WHERE ?"
			},
			job = { // job descriptor for regulator
				qos: req.profile.QoS, 
				priority: 0,
				client: req.client,
				class: req.table,
				credit: req.profile.Credit,
				name: req.table,
				task: Job.task || "",
				notes: [
						req.table.tag("?",req.query).tag("a", {href:"/" + req.table + ".run"}), 
						((req.profile.Credit>0) ? "funded" : "unfunded").tag("a",{href:req.url}),
						"RTP".tag("a", {
							href:`/rtpsqd.view?task=${Job.task}`
						}),
						"PMR brief".tag("a", {
							href:`/briefs.view?options=${Job.task}`
						})
				].join(" || ")
			},
			regmsg = `REG ${job.name}@${job.qos}`;

		if ( file.charAt(0) == "/" ) {  // fetching from a totem compliant data service
			job.Load = file.tag("?",Job);
			job.Dump = "";

			cb( job );
		}
		
		else  // fetching from db
			sql.each( regmsg,  get.files, {Name: file}, function (file) {  // regulate requested file(s)

				job.File = Copy( file, {} );
				where.fileID = file.ID;

				if ( group )  // regulate chips 
					sql.each( regmsg, get.chips, [ req.group, req.group, req, group ], function (chip) {  // process each chip
						var 
							dswhere = Copy(where,{}),
							dsargs = [req.group, req.group, dswhere, limit];

						Each(chip, function (key,val) {
							dswhere[key] = val;
						});

						sql.insertJob( Copy(job, {  // put job into the job queue
							dsevs: getEvents,
							dsargs: dsargs
						}), function (sql, job) {

							sql.all( regmsg, job.dsevs, job.dsargs, cb );

						});
					});

				else
				if (Job.aoi)  // regulate events by voxel
					sql.each( "VOXEL"+regmsg, get.voxels, [ toPolygon(Job.aoi) ], function (voxel) {

						where.voxelID = voxel.ID;

						job.Voxel = Copy( voxel, {} );
						job.Load = sql.format(get.events, [where,limit,offset] );
						job.Dump = "";

						sql.insertJob( Copy(job,{}), function (sql, job) {  // put job into the job queue
							cb( job );
						});
					});

				else  { // pull all events
					job.Load = sql.format(get.events, [where,limit,offset] );
					job.Dump = "";
					cb(job);
				}					
					/*
					sql.all( regmsg, get.events, [ req.group, req.group, where, limit ], function (err, evs) {
						cb( err ? null : evs );
					}); */
			});
	},	
	
	ingestCache: function (sql, fileID, cb) {  // ingest the evcache into the events with callback cb(aoi)
		
		sql.all(  // ingest evcache into events history by determining which voxel they fall within
			"INGEST",
			
			"INSERT INTO app.events SELECT evcache.*,voxels.ID AS voxelID "
			+ "FROM app.evcache "
			+ "LEFT JOIN app.voxels ON st_contains(voxels.Ring,evcache.Point) AND "
			+ "evcache.z BETWEEN voxels.minAlt AND voxels.maxAlt WHERE ? ",
			
			{"evcache.fileID":fileID},
			
			function (info) {

			sql.first(
				"INGEST",
				
				"SELECT "
				+ "? AS Voxelized, "
				+ "min(x) AS xMin, max(x) AS xMax, "
				+ "min(y) AS yMin, max(y) AS yMax, "
				+ "min(z) AS zMin, max(z) AS zMax, "
				// + "min(t) AS tMin, max(t) AS tMax, "
				+ "max(t)+1 AS Steps, "
				+ "max(u)+1 AS States, "
				+ "max(n)+1 AS Actors, "
				+ "count(id) AS Samples "
				+ "FROM app.evcache WHERE ?", 
				
				[ info.affectedRows, {fileID:fileID} ],	cb);
				
				/*
				function (aoi) {
				
					sql.all(  // return ingested events 
						"INGEST",
						"SELECT * FROM app.evcache WHERE ? ORDER BY t", 
						{fileID:fileID},
						function (evs) {
							cb( aoi, evs );
					});
			});  */
		});
	},

	ingestSink: function (sql, filter, fileID, cb) {  // return stream to sink evcache pipe with callback cb(aoi).
		var 
			ingested = 0,
			sink = new STREAM.Writable({
				objectMode: true,
				write: function (buf,en,cb) {
					function cache(ev) {
						ingested++;
						sql.query(
							"INSERT INTO app.evcache SET ?, Point=st_GeomFromText(?)", [{
								x: ev.x,
								y: ev.y,
								z: ev.z,
								t: ev.t,
								n: ev.n,
								u: ev.u,
								fileID: fileID
							},
							toPoint( [ev.x, ev.y] )
						]);
					}
					
					if (filter) 
						filter(buf, cache);

					else
						cache(buf);
					
					cb(null);
				}
			});
		
		sql.beginBulk();
		
		sql.query("DELETE FROM app.evcache WHERE ?",{fileID: fileID});
		sql.query("DELETE FROM app.events WHERE ?",{fileID: fileID});
		
		sink.on("finish", function () {
			sql.endBulk();
			
			//Trace(`INGEST ${ingested} EVENTS FROM FILE${fileID}`);
			
			if ( ingested )
				CHIPPER.ingestCache(sql, fileID, function (aoi) {
					cb(aoi);
					
					var
						TL = [aoi.yMax, aoi.xMin],   // [lon,lat] degs
						TR = [aoi.yMax, aoi.xMax],
						BL = [aoi.yMin, aoi.xMin],
						BR = [aoi.yMin, aoi.xMax], 
						Ring = [ TL, TR, BR, BL, TL ];

					sql.all(
						"INGEST",
						"UPDATE app.files SET ?,Ring=st_GeomFromText(?) WHERE ?", [{
							States: aoi.States,
							Steps: aoi.Steps,
							Actors: aoi.Actors,
							Samples: aoi.Samples,
							Voxelized: aoi.Voxelized,
							coherence_time: aoi.coherence_time,
							coherence_intervals: aoi.coherence_intervals,
							mean_jump_rate: aoi.mean_jump_rate,
							degeneracy: aoi.degeneracy,
							snr: aoi.snr
						},
						toPolygon( Ring ), 
						{ID: fileID} 
					]);
					
				});
		});
		
		return sink;
	},
	
	ingestList: function (sql, evs, fileID, cb) { // ingest events from supplied list with callback cb(aoi).
	/**
	@member CHIPPER
	@private
	@method ingestList
	@param {String} path to file, {streaming parms}, or [ ev, ... ] to ingest
	@param {Object} sql connector
	@param {Function} cb Response callback( ingested aoi, cb (table,id) to return info )
	Ingest events and autorun ingestable plugins if enabled.
	*/
		//Trace(`INGEST ${evs.length} EVENTS ON ${fileID}`);
		
		var 
			n = 0, N = evs.length,
			src = new STREAM.Readable({
				objectMode: true,
				read: function () {
					this.push( evs[n++] || null );
				}
			}),
			sink = CHIPPER.ingestSink(sql, null, fileID, cb);
		
		src.pipe(sink);
	},
	
	ingestFile: function (sql, filePath, fileID, cb) {  // ingest events from file path with callback cb(aoi).
	/**
	@member CHIPPER
	@private
	@method ingestFile
	@param {String} path to file, {streaming parms}, or [ ev, ... ] to ingest
	@param {Object} sql connector
	@param {Function} cb Response callback( ingested aoi, cb (table,id) to return info )
	Ingest events and autorun ingestable plugins if enabled.
	*/
		//Trace(`INGEST FILE ${filePath}`);
		function filter(buf, cb) {
			buf.split("\n").each( function (n,rec) {
				if (rec) 
					try {
						cb( JSON.parse(rec) );
					}
					
					catch (err) {
						var vals = rec.split(",");
						cb( { x: parseFloat(vals[0]), y: parseFloat(vals[1]), z: parseFloat(vals[2]), t: parseFloat(vals[3]), n: parseInt(vals[4]), u: parseInt(vals[5]) } );
					}
			});	
		}
		
		var
			src = FS.createReadStream(filePath,"utf8"),
			sink = CHIPPER.ingestSink(sql, filter, fileID, cb);

		src.pipe(sink); // ingest events into db
	},
		
	ingestService: function (chan, cb) {  // ingest events from service channel
		
		var
			tmin = chan.tmin,
			tmax = chan.tmax;
		
		CHIPPER.thread( function (sql) {	
			CHIPPER.fetch.events( {tmin:tmin,tmax:tmax}, function (evs) {
				var 
					n = 0,
					str = CHIPPER.ingestStream( sql, "guest", function () {
						var ev = evs[n++];
						this.push( ev ? JSON.stringify([ev.x,ev.y,ev.z,ev.n]) : null );
					}).pipe( str );
			});
		});
	},	
			
	thread: null,
	
	errors: {
		nowfs: new Error("chipping cataloge service failed"),
		nowms: new Error("chipping service failed to provide a wms url"),
		noStepper: new Error("engine does not exist, is not enabled, or lost stepper")
	},
	
	getImage: function (chip,det,cb) { // Load chip with pixels then callback(cb).  Auto-forecasting when needed.
		
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
				open(ENV.CHIPPER+bgname, function (bg, args) {
					
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
											bgimg.writeFile(ENV.CHIPPER+"forecast_"+fcname, "jpg", {}, function (err) {
												if (cb) cb(fcname);
											});
										});
							});
						});
				});
		
			else
				cb(bgname);
		}
			
		function runForecast(chip,det,cb) {
			if (model = CHIPPER.models.none) {  // use forecasting model
				var 
					aoi = chip.aoi,
					pixels = aoi.Ns,
					sites = pixels * pixels,
					gfs = aoi.gfs,
					name = det.name,
					obs = det.oevents.length,
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
									top: round(i / pixels),
									left: i % pixels
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
			impath = CHIPPER.fetch.save.wgetout = CHIPPER.paths.images + chip.fileID ,
			fetch = CHIPPER.fetch.image;
		
		FS.stat(impath, function (err) { // check if chip in cache
			if (err)  // not in cache
				fetch( {bbox:chip.bbox.join(",")}, function (rtn) {
					//console.log({fetchimage: rtn});

					Trace("FETCH "+chip.fileID);
					if ( !err) runForecast(chip, det, cb);
				});
			
			else { 	// in cache
				Trace("CACHE "+chip.fileID);
				runForecast(chip, det, cb);
			}
		});
		
	},
	
	tagCollect: function (chip, cb) {  // process all collects associated with requested chip with callback cb(chip) 
		Each(CHIPPER.collects, function (n,collect) {  // tag chip with collect info
			cb( Copy(collect, chip) );
		});
	},
	
	paths: {
		images: ENV.CHIPS,
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
	
	// reserved
	
	collects: {  // reserved for collects as chips are requested
	},
	
	regulate: function (sql, chip, det, cb) {
		sql.insertJob( // add job to queue and provide a callback when job departs
			Copy(chip, {  // add job and fileid keys to the chip
				qos: det.qos,
				client: det.client,
				class: det.class,
				credit: det.credit,
				priority: det.priority,
				name: chip.imageID,
				notes: det.notes,
				task: det.task,
				fileID:  ( chip.imageID == "spoof" ) 
								? "spoof.jpg" 
								: chip.index + "_" + chip.imageID + ".jpg"
			}), cb);
	},
		
	streamingWindow: null,  //< event streaming connection parameters
				// { tmin: 0,  tmax: 0 },
	
	config: function (opts) {  //< reconfigure the chipper
		
		if (opts) Copy(opts, CHIPPER);
		
		if ( streamingWindow = CHIPPER.streamingWindow)
			CHIPPER.ingestStreams(streamingWindow, function (twindow,status,sql) {
				console.log(twindow,status);
			});

		return CHIPPER;
	},
	
	chipVOI: function (chan, det, cb) {
		
		function threadEngine( sql, cb ) { // start engine thread and provide engine steeper to the callback

			var 
				req = Copy( det, {  // engine context
					group: "app",
					table: det.name,
					client: det.client,
					query: chan,
					sql: sql,
					body: {},
					action: "select",					
					state: {
						events: [],     // events inside voxel
						scenario: {}, 	// voxel scenario
						obs: {} 	// observations made inside voxel
					}
				});

			//console.log(ctx);
			ENGINE.run(req, function (ctx, step) { // start an engine thread
				
				if ( ctx )
					cb( function(evs, obs) { // use this engine stepper
						ctx.events = evs;
						ctx.obs = obs;
						if ( err = step() ) Trace(err);

						return obs;
					});

				else
					cb( null );
			});
		}
		
		CHIPPER.thread( function (sql) {

			threadEngine( sql, function (stepEngine) {

				var
					ring = chan.voiring;

				if (stepEngine)
					sql.query( 
						"SELECT * FROM app.voxels WHERE Enabled AND st_contains(st_GeomFromText(?), Point)"
						.tagQuery( chan.whereVoxel ), [ toPolygon(ring) ] )

					.on("result", function (voxel) {
						//console.log({ vox: voxel.ID} );

						sql.query( 
							"SELECT * FROM app.events WHERE ?"
							.tagQuery( chan.whereEvent ), [
								{voxelID: voxel.ID}, 
								chan.whereEvent
							], 	function (err, evs) {
								
							//Copy( {events: events, scenario: voxel}, ctx);
							console.log({ vox: voxel.ID, evs: evs.length} );
							
							if (evs.length) 
								cb( voxel, stepEngine(evs, {}), sql);

								/*ENGINE.select(req, function (rtn) {
									console.log({ev_ring_rtn:rtn});
									res( {evs: evs.length, scenario: voxel} );
									if (query.Save)
										sql.query("REPLACE INTO ?? SET ?", [ req.table, {Save: JSON.stringify(rtn)} ]);
								});*/
						});
					});
				
				else
					Trace("NO VOXEL ENGINE");

			});
		});
	},
		
	ingestStreams: function (chan, cb) {  // start stream service
		var 
			tmin = new Date(chan.tmin),
			tmax = new Date(chan.tmax),
			tint = 400, // hours
			tInt = tint * 3600e3, // milisecs
			tLook = tmax - tmin, // millsecs
			tlook = tLook / 3600e3; // hours

		if ( ingestService = CHIPPER.ingestService )
			for (var t=tnext=tmin; t<tmax; t=tnext) {
				chan.tmin = t;
				chan.tmax = tnext = new Date( t.getTime() + tInt);
				ingestService(chan, cb);
			}
	},
	
	chipAOI: function (chan, det, cb) {  // start detector on new sql thread
		
		function threadEngine( sql, cb ) { // start engine thread and provide engine stepper to callback

			var 
				req = Copy( det, {  // engine context
					group: "app",
					table: det.name,
					client: det.client,
					query: chan,
					body: {},
					sql: sql,
					action: "select",
					state: {
						frame: {  // input port
							job: ""
						},
						detector: {   // output port
							scale: det.step, 
							dim: aoi.gfs,
							delta: det.range,
							hits: det.detects,
							cascade: [
								ENV.DETS + "cars/haar/ver0/cascade"
							],
							dets: [],
							net: ENV.DETS + "cars/cnn/test0_lenet_"
						}
					}
				}),
				dets = req.state.detector.dets,
				images = CHIPPER.paths.images;

			for (var n=0, Ndets = 3 /*aoi.Nf*aoi.Nf*/ ; n<Ndets ; n++) // opencv engines require a tau reserve
				dets.push( {res:0} );

			//console.log({detreserve: dets.length});
			
			ENGINE.run(req, function (ctx, step) { // start an engine thread
				
				if ( ctx )
					cb( function(chip,dets) { // use this engine stepper
						ctx.frame.job = images + chip.fileID;

						if ( err = step() ) Trace(err);

						ctx.detector.dets.each = Array.prototype.each;
						ctx.detector.dets.each( function (n,det) {
							//console.log({det:det});
							//if (det.job == "set") dets.push(det);
							//dets.push(det);
						});
						
						return dets;
					});

				else
					cb( null );
			});
		}

		function eachCollect( chan, cb ) {  // prime collection process then callback cb()
			var 
				collects = CHIPPER.collects,
				fetch = CHIPPER.fetch.catalog;

			chan.geometryPolygon = JSON.stringify({rings: chan.aoiring});  // ring being monitored
			delete chan.aoiring;

			console.log({collecting:chan});

			fetch(chan, function (cat) {  // query catalog for desired data channel

				//console.log({fetchcat: cat});
				
				if ( cat ) {
					switch ( chan.source ) {  // normalize response to ess
						case "dglobe":
							break;
						case "omar":
							break;
						case "ess":
						default:
					}

					var
						results = ( cat.GetRecordsResponse || {SearchResults: {}} ).SearchResults,
						datasets = results.DatasetSummary || [];

					datasets.each( function (n,collect) {  // pull image collects from each catalog entry
						var 
							image = collect["Image-Product"].Image,
							sun = image["Image-Sun-Characteristic"] || {SunElevationDim: "0", SunAzimuth: "0"},
							restrict = collect["Image-Restriction"] || {Classification: "?", ClassificationSystemId: "?", LimitedDistributionCode: ["?"]},
							raster = image["Image-Raster-Object-Representation"],
							region = collect["Image-Country-Coverage"] || {CountryCode: ["??"]},
							atm = image["Image-Atmospheric-Characteristic"],
							urls = {
								wms: collect.WMSUrl,
								wmts: collect.WMTSUrl,
								jpip: collect.JPIPUrl
							};

						if (urls.wms) { // valid collects have a wms url
							// ImageId == "12NOV16220905063EA00000 270000EA530040"
							Trace("COLLECTED "+image.ImageId);

							collects[image.ImageId] = {  // add collect to internal catalog
								imported: new Date(image.ImportDate),
								collected: new Date(image.QualityRating),
								mission: image.MissionId,
								sunEl: parseFloat(sun.SunElevationDim),
								sunAz: parseFloat(sun.SunAzimuth),
								layer: collect.CoverId,
								clouds: atm.CloudCoverPercentageRate,
								country: region.CountryCode[0],
								classif: restrict.ClassificationCode + "//" + restrict.LimitedDistributionCode[0],
								imageID: image.ImageId.replace(/ /g,""),
								mode: image.SensorCode,
								bands: parseInt(image.BandCountQuantity),
								gsd: parseFloat(image.MeanGroundSpacingDistanceDim)*25.4e-3,
								wms: urls.wms
									.replace(
										"?REQUEST=GetCapabilities&VERSION=1.3.0",
										"?request=GetMap&version=1.1.1")
									.tag({
										width: aoi.lat.pixels,
										height: aoi.lon.pixels,
										srs: "epsg%3A4326",
										format: "image/jpeg"
									})
							};
						}

						else
							Trace(CHIPPER.errors.nowms);
					});
				}

				cb();
			});
		}
		
		//if ( !chan.ring ) chan.ring = CHIPPER.spoof.ring;
		
		var aoi = CHIPPER.aoi = new AOI( chan.aoiring, det.scale, det.pixels, det.size );
		
		console.log({chipping_aoi: [aoi.lat.steps, aoi.lon.steps]});
					 
		CHIPPER.thread( function (sql) {  // start a sql thread
			threadEngine( sql, function (stepEngine) {  // start detector engine thread
				eachCollect( chan, function () { // for each collect on this channel
					
					if (stepEngine)  // detector provided
						aoi.chipArea(det, function (chip,sql) {  // get the next chip is this aoi
							cb(chip, stepEngine( chip, [] ), sql);  // step detector on this chip
						});

					else  // no detector provided so just chip
						aoi.chipArea(det, function (chip,sql) {
							cb(chip, null, sql);
						});	
				});
			});
		});
		
	},
	
	started: new Date(),
	
	cacheInfo: {
		maxage: 30,
		flush: false
	}
	
};

function SOLAR(day,tod,tz,lat,lon) {
	var D2R = Math.PI / 180, R2D = 1/D2R;
	
	function sin(x) { return Math.sin(D2R * x); }
	function cos(x) { return Math.cos(D2R * x); }
	function tan(x) { return Math.tan(D2R * x); }
	function tan(x) { return Math.tan(D2R * x); }
	function atan2(x) { return R2D * Math.atan2(x,y); }
	function asin(x) { return R2D * Math.asin(x); }
	function acos(x) { return R2D * Math.acos(x); }
	function pow(x,a) { return Math.pow(x,a); }
	
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
		sal = this.sal = stl - 0.0059 - 0.00478 * sin(125.04 - 1934.136 * jcen), // sun app lon [deg]
		moe = this.moe = 23 + (26 + ((21.448 - jcen*(46.815 + jcen * (0.0059 - jcen*0.001813)))) / 60) / 60, // mean obliq ecliptic [deg]
		oc = this.oc = moe + 0.00256 * cos(125.04 - 1934.136*jcen),  // obliq correction [deg]
		sra = this.sra = atan2( cos(sal), cos(oc) * sin(sal) ),  // sun right ascention [deg]
		sde = this.sde = asin( sin(oc) * sin(sal)),  // sun declination [deg]
		vary = this.vary = pow( tan( oc/2 ), 2),   // var y
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
						? 58.1/tan(sea) - 0.07/pow(tan(sea),3) + 0.000086/pow(tan(sea),5)
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
	deg: function (c) { return [this.y*c, this.x*c]; },
	add: function (u) { this.x += u.x; this.y += u.y; return this; },
	sub: function (u) { this.x -= u.x; this.y -= u.y; return this; },
	scale: function (a) { this.x *= a; this.y *= a; return this; },
	set: function (u) { this.x *= u.x; this.y *= u.y; return this; },
	copy: function () { return new POS(this.x,this.y); }
}

/*===================================================
AOI interface
*/

function AOI(ring,Nf,Ns,gfd) {

	var 
		cos = Math.cos,
		acos = Math.acos,
		sin = Math.sin,
		asin = Math.asin,
		pow = Math.pow,
		random = Math.random,
		round = Math.round,
		floor = Math.floor,
		min = Math.min,
		max = Math.max;
		sqrt = Math.sqrt;

	/*
	Haversine functions to compute arc length on sphere of radius r
	*/

	function hsine(t12) { return (1-cos(t12))/2; }  // havesine between two points subtending angle t12
	function ahsine(h12) { return 2 * asin(sqrt(h12)); }
	function hdist(h12,r) { return r * ahsine(h12); }
	function hsine2 (lat,lon) { return hsine(lat[1]-lat[0]) + cos( lat[1] ) * cos( lat[0] ) * hsine(lon[1]-lon[0]); }  // between 2 pts on great circle

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
		ol = aoi.ol = 1/Nf, 							// chip overlap
		gcd = aoi.gcd = Nf * gfd/1000,			// chip dimension [km]
		r = aoi.r = 6137, 								// earth radius [km]
		u = aoi.u = 2*pow(sin(gcd/(2*r)),2), // angle formed
		dlon = acos(1 - u), 							// delta lon to keep chip height = chip width = gcd
		dlat = acos(1 - u / pow(cos(lat),2)); 	// delta lat to keep chip height = chip width = gcd

	//console.log({aoi:ring,number_of_features:Nf,number_of_samples:Ns,gcd:gcd,gfd:gfd,lat:lat,lon:lon,dels: [dlat,dlon], ol:ol});	

	aoi.csd = gcd *1000/Ns; 		// chip sampling dimension [m]
	aoi.gfs = round(Ns/Nf);	// ground feature samples [pixels]
	aoi.Ns = Ns;  // samples across chip [pixels]
	aoi.Nf = Nf;  // features along a chip dimension
	aoi.gfd = gfd; // ground feature dimension [m]
	aoi.mode = "curvedearth";
	
	aoi.lat = {min:lat, max:maxlat(TL,BL,TR,BR), ol:ol, pixels: Ns, del:dlat, val:lat, gcd:gcd, idx:0};
	aoi.lon = {min:lon, max:maxlon(TL,BL,TR,BR), ol:ol, pixels: Ns, del:dlon, val:lon, gcd:gcd, idx:0};
	
	aoi.lat.steps = floor( (aoi.lat.max - lat) / dlat );
	aoi.lon.steps = floor( (aoi.lon.max - lon) / dlon );
	
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
	getChip: function (sql,det,cb) { // callback cb(chip) with next chip in this chipping process
		var
			aoi = this,
			lat = this.lat,
			lon = this.lon,
			regulate = CHIPPER.regulate,
			withinAOI = lat.val <= lat.max;
		
		if (withinAOI) // process if within aoi
			CHIPPER.tagCollect( new CHIP(aoi), function (chip) {  // create a chip, tag it with collect info, then callback

				if ( aoi.chips++ < CHIPPER.limit )  // process if max chips not reached
					regulate(sql, chip, det, cb);
			});
				
		return withinAOI;	
	},

	chipArea: function (det,cb) {  // start regulated chipping 
		var aoi = this;
		
		aoi.chips = 0;  // reset chip counter
		
		CHIPPER.thread( function(sql) {  // start a thread to deposit chipping work into a job queue
			
			while ( aoi.getChip( sql, det, function (sql,chip) {  // while there is a chip in this aoi
				CHIPPER.getImage( chip, det, function (chip) {  // prime pixels then process the chip
					cb(chip,sql);
				});
			}) );
			
		});	
	}
};

function CHIP(aoi) {
	var
		cos = Math.cos,
		acos = Math.acos,	
		eps = {pos: 0.00001, scale:0.01},
		pow = Math.pow,		
		lat = aoi.lat,
		lon = aoi.lon,
		c = aoi.c,
		pos = this.pos = {lat: (lat.val*c).toFixed(6), lon: (lon.val*c).toFixed(6)};
	
	this.min = {lat: pos.lat*(1-eps.pos), lon:pos.lon*(1-eps.pos), scale:aoi.scale*(1-eps.scale)};
	this.max = {lat: pos.lat*(1+eps.pos), lon:pos.lon*(1+eps.pos), scale:aoi.scale*(1+eps.scale)};
	this.index = ("000"+lat.idx).substr(-3) + "_" + ("000"+lon.idx).substr(-3);
	this.aoi = aoi;
	this.height = lat.gcd;
	this.width = lon.gcd;
	this.rows = lat.pixels;
	this.cols = lon.pixels;
	this.made = new Date(); 
				
	var 
		TL = this.TL = new POS(lat.val+lat.del, lon.val),  // {x:lat, y:lon} rads
		BL = this.BL = new POS(lat.val, lon.val),
		TR = this.TR = new POS(lat.val+lat.del, lon.val+lon.del),
		BR = this.BR = new POS(lat.val, lon.val+lon.del);
		
	//console.log({lat: lat,lon: lon});
	
	var 
		TLd = TL.deg(c), // [lat,lon] rads --> [lon,lat] degs
		BLd = BL.deg(c),
		TRd = TR.deg(c), 
		BRd = BR.deg(c); 
		
	this.bbox = [TLd[0], TLd[1], BRd[0], BRd[1]];   // [min lon,lat, max lon,lat]  (degs)
	this.point = toPoint(TLd);
	this.ring = toPolygon( [TLd, BLd, BRd, TRd, TLd] );

	switch (aoi.mode) { // advance lat,lon
		case "curvedearth":
			if ( lon.val < lon.max ) {  // advance lon
				lon.val += lon.del * (1-lon.ol);
				lon.idx++;
			}
			
			else { // reset lon and advance lat
				lon.val = lon.min;
				lon.idx = 0;
				lat.val += lat.del + (1-lat.ol);
				lat.del = acos(1-aoi.u/pow(cos(lat.val),2));
				lat.idx++;
			}
			break;
	
		case "flatearth":
			break;
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
	forecast: function (f,det,model,obs,cb) {
		var chip = this;
		
		Trace(`FORECASTING ${det} WITH ${chip.fileID} USING ${model} AT ${f}%`);
		
		var fchip = Copy(chip,{});
		
		fchip.ID = "forecasts/"+f+"_"+chip.fileID;
		
		/*
		if (thread = CHIPPER.thread) // save roc
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

	runForecast: function (det,cb) {
		var
			chip = this,
			pixels = chip.aoi.gfs,
			sites = chip.aoi.sites,
			tip = { width: 64, height: 64};

		if (false)
			makeJPG({
				LAYER: chip.aoi.layerID,
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
				
				if ( model = CHIPPER.models.debug )  {  // CHIPPER.models[bchip.cache.forecast] 
					Trace(`FORECASTING ${bchip.job} USING ${model.name}`);
					
					model.levels.each( function (n,f) {
						var fchip = CHIP.clone(bchip); // initialize forecasting chip to background chip
						
						fchip.forecast(f, function (roc) { // run forecast at level f
							embedPositives(
								bchip.job,  		// name of background jpg 
								fchip.job,			// name of forecasting jpi containing embedded jpgs
								roc.Npos, 			// number of chips to embed
								model.srcs,			// candidate sources to embed
								model.scales.clone().scale(pixels), // candidate embed scales
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
	ENUM.trace("C>",msg,arg);
}

function util(sql, runopt, input, rots, pads, flips) {
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

if (args = process.argv)
if (args.length >= 3)
if (thread = CHIPPER.thread)
	thread(function (sql) {
		switch ( args[2] ) {
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

			default:
				Trace("IGNORING UTIL SWITCH "+args[2]);
		}
	});

if (false) {
	var 
		c = 180/Math.PI,
		ring = [
			[70.0899, 33.9108], // TL lon,lat [degs]
			[70.0988, 33.9018], // TR
			[70.0988, 33.9105], // BR
			[70.0899, 33.9105] // BL
		];

	console.log({deg: ring[0], rad: ring[0].pos(c), degrtn: ring[0].pos(c).deg(c)});
}

function toPolygon(ring) {  // [ [lon,lat], ... ] degs
	return 'POLYGON((' + [  
		ring[0].join(" "),
		ring[1].join(" "),
		ring[2].join(" "),
		ring[3].join(" "),
		ring[0].join(" ") ].join(",") +'))' ;
}

function toPoint( u ) {  // [lon,lat] degs
	return 	`POINT(${u[0]} ${u[1]})`
}

		