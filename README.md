/**
@class GEOHACK
	[SourceForge](https://sourceforge.net) 
	[github](https://github.com/acmesds/geohack.git) 
	[geointapps](https://git.geointapps.org/acmesds/geohack)
	[gitlab](https://gitlab.weat.nga.ic.gov/acmesds/geohack.git)
	
# GEOHACK

## Installing

Clone from one of the repos into your PROJECT/geohack, then:

	cd PROJECT/geohack
	ln -s PROJECT/totem/test.js test.js 			# unit testing
	ln -s PROJECT/totem/maint.sh maint.sh 		# test startup and maint scripts

Dependencies:

* [ENUM basic enumerators](https://github.com/acmesds/enum)
* openv.profiles Reads and populates when clients arrive  
* openv.sessions Reads and populates when client sessions are established  
* openv.riddles Builds on config() and reads when clients arrive  
* openv.apps Reads on config() to override GEOHACK options and define site context parameters

## Using

Each configuration follow the 
[ENUM deep copy() conventions](https://github.com/acmesds/enum):

	var GEOHACK = require("geohack").config({
		key: value, 						// set key
		"key.key": value, 					// indexed set
		"key.key.": value					// indexed append
	}, function (err) {
		console.log( err ? "something evil is lurking" : "look mom - Im running!");
	});

where its [key:value options](/shares/prm/debe/index.html) override the defaults.

### G1
### G2


## License

[MIT](LICENSE)
*/