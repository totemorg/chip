/**
@class GEOHACK
	[SourceForge](https://sourceforge.net) 
	[github](https://github.com/acmesds/geohack.git) 
	[geointapps](https://git.geointapps.org/acmesds/geohack)
	[gitlab](https://gitlab.weat.nga.ic.gov/acmesds/geohack.git)
	
# GEOHACK

## Installation

Clone [GEOHACK chipper](https://github.com/acmesds/geohack) into your PROJECT/geohack folder.  
Clone [ENUM enumerators](https://github.com/acmesds/enum) into your PROJECT/enum folder.  

### Required MySQL Databases

* openv.profiles Reads and populates when clients arrive  
* openv.sessions Reads and populates when client sessions are established  
* openv.riddles Builds on config() and reads when clients arrive  
* openv.apps Reads on config() to override GEOHACK options and define site context parameters

### Manage 

	npm run [ edit || start ]			# Configure environment
	npm test [? || G1 || G2 || ...]			# unit test
	npm run [ prmprep || prmload ]		# Revise PRM
	
## Usage

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