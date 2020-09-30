# GEOHACK

## Installation

Clone [GEOHACK chipper]REPO{geohack} into your PROJECT/geohack folder.  

## Requires

[ENUM enumerators]REPO{enum}.  

Required MySQL Databases

* openv.profiles Reads and populates when clients arrive  
* openv.sessions Reads and populates when client sessions are established  
* openv.riddles Builds on config() and reads when clients arrive  
* openv.apps Reads on config() to override GEOHACK options and define site context parameters

## Manage 

	npm test [? || G1 || G2 || ...]		# unit test
	npm run [ edit || start ]			# Configure environment
	npm run [ prmprep || prmload ]		# Revise PRM
	
## Usage

Access and configure GEOHACK like this:

	var GEOHACK = require("geohack").config({
		key: value, 						// set key
		"key.key": value, 					// indexed set
		"key.key.": value					// indexed append
	}, function (err) {
		console.log( err ? "something evil is lurking" : "look mom - Im running!");
	});

where [its configuration keys]SITE{shares/prm/geohack/index.html}
follow the [ENUM deep copy conventions]REPO{enum}.


### G1
### G2

## Contributing

To contribute to this module, see our [issues](https://totem.west.ile.nga.ic.gov/issues.view)
and [milestones](https://totem.west.ile.nga.ic.gov/milestones.view).

## License

[MIT](LICENSE)
